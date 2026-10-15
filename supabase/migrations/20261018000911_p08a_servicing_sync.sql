-- =============================================================================================
-- Phase 08a, servicing sync and file import (stream SERVICING SYNC AND FILE IMPORT), part 2 of 2.
-- Spec: docs/specs/08-servicing-payments-mandates-collections.md sections 6, 12 (data), 15, 18, 21 (Sync) and the
-- owner decisions of 14 October 2026 (4: manual and file import first, nothing silently overwritten, source lender /
-- system / batch / record id / reported timestamp recorded; 10: import files are all or nothing).
--
-- What this migration does
--   1. servicing.lms_connections       one connection per lender; only file_import and manual may be active (mock only under
--                                      the foundation guard); finbyx and generic_rest can only be blocked_unverified.
--   2. servicing.import_batches/rows   staged, previewed, committed import files. The whole file is validated first. A file with
--                                      any error is `invalid` and cannot be committed; a failed or rejected attempt keeps no
--                                      row values (data minimisation), only hashes, counts, positions and error codes.
--   3. servicing.apply_lms_report      the single implementation for every source (file, manual, mock, REST later).
--   4. Append-only records of what the lender REPORTED, with provenance: balance_snapshots, lms_receipts, new columns on
--      schedule_snapshots. Anomalies are flagged (never corrected), conflicts and quarantined reports are queued (never
--      resolved by code). Udofin never computes a balance, interest, charge or foreclosure amount.
--   5. Borrower reads (servicing.my_loans / my_loan: reported figures only) and lender reads (RLS, loan.read), the history
--      functions loan_as_reported_at / loan_as_known_at, and servicing.record_rejected_file (audit record for a file the importer
--      refused before any record reached the database).
--
-- Fail closed: every function that writes needs the servicing_sync switch of the lender (private.require_feature), an
-- active connection of the right kind, and (for people) aal2 plus the named permission. Nothing here moves money.
-- Forward-only. No new enum values are used except those added by 20261018000909.
-- Error convention: SQLSTATE and hint. 42501 not authorised, P0002 not found, 22023 bad input, 55000 rule or state,
-- 23505 duplicate.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- A. Small helpers (no grants: only SECURITY DEFINER functions of this migration call them)
-- ---------------------------------------------------------------------------------------------
create or replace function private.servicing_money_text(p_minor bigint)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$ select (p_minor / 100)::text || '.' || lpad((p_minor % 100)::text, 2, '0') $$;

-- The helpers below return null for anything invalid and use NO exception block (a subtransaction per call made a 10 000
-- record file slow); the conversion itself is always private.parse_money_minor, the one money parser.
create or replace function private.servicing_try_money(p_text text)
returns bigint
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
begin
  -- Same grammar and ceiling as private.parse_money_minor (the pre-check only avoids raising for what it would refuse).
  if p_text is null or p_text !~ '^(0|[1-9][0-9]{0,15})([.][0-9]{1,2})?$' then
    return null;
  end if;
  -- Ceiling 1 000 000 000 000.00 rupees, checked on the text (no numeric or floating-point arithmetic anywhere).
  if length(split_part(p_text, '.', 1)) > 13
     or (length(split_part(p_text, '.', 1)) = 13 and (split_part(p_text, '.', 1) <> '1000000000000' or split_part(p_text, '.', 2) !~ '^0*$')) then
    return null;
  end if;
  return private.parse_money_minor(p_text);
end
$$;

-- A real calendar date written YYYY-MM-DD, years 2000 to 2100 (the same rule as the TypeScript importer), else null.
create or replace function private.servicing_try_date(p_text text)
returns date
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_y integer;
  v_m integer;
  v_d integer;
begin
  if p_text is null or p_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  v_y := substr(p_text, 1, 4)::integer;
  v_m := substr(p_text, 6, 2)::integer;
  v_d := substr(p_text, 9, 2)::integer;
  if v_y not between 2000 and 2100 or v_m not between 1 and 12 or v_d < 1 then return null; end if;
  if v_d > extract(day from (make_date(v_y, v_m, 1) + interval '1 month' - interval '1 day'))::integer then return null; end if;
  return make_date(v_y, v_m, v_d);
end
$$;

-- ISO-8601 with an explicit zone and at most millisecond precision (the TypeScript rule), else null. Zone offsets are limited
-- to +-15:59, the range PostgreSQL accepts (real offsets stop at +14:00).
create or replace function private.servicing_try_ts(p_text text)
returns timestamptz
language plpgsql
stable
parallel safe
set search_path = ''
as $$
begin
  if p_text is null
     or p_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?(Z|[+-](0[0-9]|1[0-5]):[0-5][0-9])$'
     or private.servicing_try_date(left(p_text, 10)) is null then
    return null;
  end if;
  return p_text::timestamptz;
end
$$;

-- Canonical UTC text with milliseconds, identical to JavaScript's Date.toISOString().
create or replace function private.servicing_ts_text(p_ts timestamptz)
returns text
language sql
stable
parallel safe
set search_path = ''
as $$ select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create or replace function private.servicing_text_array(p_json jsonb)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$ select coalesce(array(select jsonb_array_elements_text(p_json)), '{}'::text[]) $$;

-- SHA-256 over the JSON text ["udofin-lms-<type>-v1", [key, value], ...], byte for byte what lmsReportHash in
-- packages/adapters/src/lms.ts produces (compact JSON, bigint as a decimal string, absent as null).
create or replace function private.servicing_hash(p_type text, p_pairs jsonb)
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
  select encode(sha256(convert_to(
    '["udofin-lms-' || p_type || '-v1"' ||
    coalesce((
      select string_agg(
        ',[' || to_json(e.value ->> 0)::text || ',' ||
        case jsonb_typeof(e.value -> 1)
          when 'null' then 'null'
          when 'string' then to_json(e.value ->> 1)::text
          else (e.value ->> 1) end || ']', '' order by e.ord)
      from jsonb_array_elements(p_pairs) with ordinality as e(value, ord)), '') || ']', 'UTF8')), 'hex')
$$;

create or replace function private.servicing_sha256_text(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$ select encode(sha256(convert_to(p_text, 'UTF8')), 'hex') $$;

-- The closed set of field names an import record may contain, and the only names that may appear in stored error rows.
-- There is no personal-data field in it: borrower_ref is an opaque reference and is refused if it looks like a PAN, phone,
-- Aadhaar, account or card number (the lender's file specification keeps names out; a name cannot be recognised by shape).
create or replace function private.servicing_known_fields()
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select array[
    'lms_loan_ref', 'borrower_ref', 'status', 'sanctioned_amount', 'disbursed_amount', 'disbursement_ref', 'disbursement_date',
    'outstanding_principal', 'next_due_date', 'next_due_amount', 'overdue_principal', 'overdue_interest', 'penal_charges',
    'other_charges', 'total_overdue', 'days_past_due', 'source_record_id', 'reported_as_of', 'sequence',
    'lms_receipt_ref', 'receipt_kind', 'reverses_receipt_ref', 'amount', 'value_date', 'payment_mode', 'bank_reference',
    'installments', 'installment_seq', 'due_date', 'principal', 'interest', 'fees', 'content_sha256']
$$;

-- A stored (canonical) record may only use the closed field set; installments only the installment fields.
create or replace function private.servicing_normalised_ok(p_rec jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_rec is null or (
    jsonb_typeof(p_rec) = 'object'
    and octet_length(p_rec::text) <= 200000
    and not exists (select 1 from jsonb_object_keys(p_rec) k where k <> all (private.servicing_known_fields()))
    and not exists (
      select 1
      from jsonb_array_elements(case when jsonb_typeof(p_rec -> 'installments') = 'array' then p_rec -> 'installments' else '[]'::jsonb end) i,
           lateral jsonb_object_keys(case when jsonb_typeof(i) = 'object' then i else '{}'::jsonb end) ik
      where ik <> all (array['installment_seq', 'due_date', 'principal', 'interest', 'fees']))
    and (p_rec -> 'installments' is null or jsonb_typeof(p_rec -> 'installments') = 'array'))
$$;

create or replace function private.servicing_capabilities_ok(p_caps jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_caps is not null and jsonb_typeof(p_caps) = 'object'
    and not exists (
      select 1 from jsonb_each(p_caps) e
      where e.key <> all (array['pull', 'push', 'receipts', 'schedule', 'foreclosure_quote', 'statement', 'closure_documents'])
         or jsonb_typeof(e.value) <> 'boolean')
$$;

-- Audit through the existing path. A signed-in person goes through private.record_audit_event (the actor and organisation are
-- derived from the session, never passed in); the system role writes a system event. Metadata holds identifiers, counts and
-- class names only.
create or replace function private.servicing_audit(p_tenant uuid, p_action text, p_entity_type text, p_entity_id text, p_meta jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    perform private.record_audit_event(p_action, p_entity_type, p_entity_id, p_tenant, 'success', coalesce(p_meta, '{}'::jsonb));
  else
    insert into audit.events (actor_type, tenant_org_id, action, entity_type, entity_id, outcome, metadata)
    values ('system', p_tenant, p_action, p_entity_type, p_entity_id, 'success', coalesce(p_meta, '{}'::jsonb));
  end if;
end
$$;
revoke all on function private.servicing_audit(uuid, text, text, text, jsonb) from public;

-- ---------------------------------------------------------------------------------------------
-- B. Validation of one import record (set-wise callers apply it with a lateral join). Returns
--    {canon, hash, codes, fields, flags, srid}. `canon` is the record in canonical form (money as two-decimal rupee text,
--    timestamps in UTC milliseconds) and is null when there is any error. Error codes are classes; a value is never echoed.
--    p_meta additionally allows report_type, source_system and content_sha256 (the apply entry point).
--    Mirrors packages/adapters/src/lms.ts (normaliseLmsLoan / Receipt / Schedule): nothing is trimmed, repaired or guessed.
-- ---------------------------------------------------------------------------------------------
-- (No SET search_path on purpose: it references no object, and a function with a SET clause cannot be inlined, which made
-- every call about ten times slower on a large file.)
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
    ('receipt', 'payment_mode', 'ref', false),
    ('receipt', 'bank_reference', 'ref', false),
    ('receipt', 'source_record_id', 'ref', true),
    ('receipt', 'reported_as_of', 'ts', true),
    ('receipt', 'sequence', 'int9', false),
    ('schedule', 'lms_loan_ref', 'ref', true),
    ('schedule', 'source_record_id', 'ref', true),
    ('schedule', 'reported_as_of', 'ts', true),
    ('schedule', 'sequence', 'int9', false)
  ) as s (kind, name, ftype, required) where s.kind = p_kind
$$;

-- One cell: {"v": value} or {"e": error code}. Absent cells (missing, JSON null, empty string) are handled by the caller.
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
  v_compact text;
  v_date date;
  v_max bigint;
begin
  case p_ftype
    when 'ref', 'opaque' then
      if jsonb_typeof(p_cell) <> 'string' then return jsonb_build_object('e', 'invalid_reference'); end if;
      v_text := p_cell #>> '{}';
      if p_ftype = 'opaque' then
        v_compact := regexp_replace(v_text, '[-.:/_]', '', 'g');
        if v_compact ~ '[A-Za-z]{5}[0-9]{4}[A-Za-z]' or v_compact ~ '^\+?[0-9]{9,18}$' then
          return jsonb_build_object('e', 'borrower_ref_looks_personal');
        end if;
      end if;
      if v_text !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$' then return jsonb_build_object('e', 'invalid_reference'); end if;
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
  'Validates one import record of format udofin-lms-import-v1 and returns {canon, hash, codes, fields, flags, srid}. Mirrors packages/adapters/src/lms.ts. Error codes are classes; no value is ever echoed. The content hash equals lmsReportHash.';

-- ---------------------------------------------------------------------------------------------
-- C. Tables
-- ---------------------------------------------------------------------------------------------

-- C1. LMS connection: one per lender. There is no connector for any real LMS; file import and manual entry come first.
create table servicing.lms_connections (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null unique references tenancy.organizations (id) on delete restrict,
  kind text not null check (kind in ('file_import', 'manual', 'mock', 'finbyx', 'generic_rest')),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'blocked_unverified')),
  provider_mode private.provider_mode not null default 'production',
  capabilities jsonb not null default '{}'::jsonb check (private.servicing_capabilities_ok(capabilities)),
  staleness_threshold_minutes integer not null default 1440 check (staleness_threshold_minutes between 5 and 43200),
  -- The NAME of a secret in the secrets manager, never the secret. Only the REST kinds (blocked) may carry one.
  secret_ref text check (secret_ref is null or secret_ref ~ '^[A-Za-z][A-Za-z0-9_./-]{2,99}$'),
  cursor text check (cursor is null or length(cursor) <= 500),
  last_success_at timestamptz,
  created_by uuid references auth.users (id),
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- No specification exists for finbyx or a generic REST feed: such a row can exist but never be active.
  constraint unverified_kinds_blocked check ((kind in ('finbyx', 'generic_rest')) = (status = 'blocked_unverified')),
  constraint mock_kind_has_mock_mode check ((kind = 'mock') = (provider_mode = 'mock')),
  constraint secret_ref_only_for_connectors check (secret_ref is null or kind in ('finbyx', 'generic_rest'))
);
comment on table servicing.lms_connections is
  'One LMS connection per lender: kind (file_import, manual, mock, finbyx, generic_rest), status, capability flags, staleness threshold and the NAME of a secret (never the secret). Only file_import and manual can be active; mock only under the udofin.allow_mock_providers guard and never in production; finbyx and generic_rest rows can exist but only as blocked_unverified because no specification exists (enforced by a check). Written only by servicing.set_lms_connection (servicing.sync.manage, aal2, servicing_sync switch on). Owner: servicing module.';
create trigger guard before insert or update on servicing.lms_connections
  for each row execute function private.guard_provider_mode('provider_mode');
create trigger lms_connections_set_updated_at before update on servicing.lms_connections
  for each row execute function private.set_updated_at();
create trigger no_delete before delete on servicing.lms_connections
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.lms_connections
  for each statement execute function private.forbid_truncate();

-- C2. Import batches (one per distinct file, per lender).
create table servicing.import_batches (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  kind text not null check (kind in ('loan', 'receipt', 'schedule')),
  source_kind text not null check (source_kind in ('file', 'manual')),
  source_system servicing.source_system not null check (source_system::text in ('file_import', 'manual_import')),
  format_version text not null check (format_version = 'udofin-lms-import-v1'),
  -- Identity of the file. The file NAME is never stored (it can contain names); neither is any row content once the batch
  -- is invalid, rejected or failed.
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size between 1 and 52428800),
  idempotency_key text not null check (length(idempotency_key) between 16 and 128),
  status text not null default 'uploaded' check (status in ('uploaded', 'previewed', 'invalid', 'committed', 'rejected', 'failed')),
  row_count integer not null check (row_count between 1 and 10000),
  count_new integer not null default 0 check (count_new >= 0),
  count_unchanged integer not null default 0 check (count_unchanged >= 0),
  count_duplicate integer not null default 0 check (count_duplicate >= 0),
  count_changed integer not null default 0 check (count_changed >= 0),
  count_conflict integer not null default 0 check (count_conflict >= 0),
  count_error integer not null default 0 check (count_error >= 0),
  count_quarantined integer not null default 0 check (count_quarantined >= 0),
  -- Rows that carry an older report than the one already stored (ignored and counted; also counted under unchanged).
  count_ignored_older integer not null default 0 check (count_ignored_older >= 0),
  reported_as_of_min timestamptz,
  reported_as_of_max timestamptz,
  -- What was actually applied at commit (counts per applied_result), set once.
  applied_counts jsonb check (applied_counts is null or jsonb_typeof(applied_counts) = 'object'),
  -- The earlier batch this file corrects, when the lender says so. Linkage only: the earlier batch is never changed.
  resubmission_of uuid,
  uploaded_by uuid not null references auth.users (id),
  uploaded_at timestamptz not null default now(),
  committed_by uuid references auth.users (id),
  committed_at timestamptz,
  rejected_by uuid references auth.users (id),
  rejected_at timestamptz,
  reject_reason text check (reject_reason is null or length(trim(reject_reason)) between 10 and 1000),
  -- SQLSTATE of the error that made a commit fail and roll back; never a message (messages can carry values).
  failure_class text check (failure_class is null or failure_class ~ '^[0-9A-Z]{5}$'),
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lender_org_id, idempotency_key),
  unique (id, lender_org_id),
  foreign key (resubmission_of, lender_org_id) references servicing.import_batches (id, lender_org_id) on delete restrict,
  constraint not_own_resubmission check (resubmission_of is null or resubmission_of <> id),
  constraint counts_add_up check (status = 'uploaded' or count_new + count_unchanged + count_duplicate + count_changed + count_conflict
      + count_error + count_quarantined = row_count),
  constraint invalid_has_errors check (status <> 'invalid' or count_error + count_quarantined > 0),
  constraint ready_has_no_errors check (status not in ('previewed', 'committed') or count_error + count_quarantined = 0),
  constraint committed_has_actor check (status <> 'committed' or (committed_by is not null and committed_at is not null and applied_counts is not null)),
  constraint rejected_has_reason check (status <> 'rejected' or (rejected_by is not null and rejected_at is not null and reject_reason is not null)),
  constraint failed_has_class check (status <> 'failed' or (failure_class is not null and failed_at is not null)),
  constraint minimal_when_discarded check (status not in ('invalid', 'rejected', 'failed') or (reported_as_of_min is null and reported_as_of_max is null))
);
-- The same file twice returns the same batch while that batch is live. A rejected or failed batch releases its file hash, so the
-- same file can be staged again (as a new batch, with a new idempotency key).
create unique index import_batches_live_file on servicing.import_batches (lender_org_id, file_sha256)
  where status in ('uploaded', 'previewed', 'invalid', 'committed');
create index import_batches_lender on servicing.import_batches (lender_org_id, uploaded_at desc);
create index import_batches_resubmission on servicing.import_batches (resubmission_of);
comment on table servicing.import_batches is
  'One row per distinct import file per lender (unique per lender and file SHA-256 while the batch is live: the same file twice returns the same batch; a rejected or failed batch releases the hash). Status uploaded, previewed, committed, rejected, failed or invalid. Imports are ALL OR NOTHING (owner decision of 14 Oct 2026): a file with any error is invalid and cannot be committed; a commit applies every row in one transaction or none. Invalid, rejected and failed batches keep only the file hash, byte size, counts, and per-row positions, record-id hashes, error codes and field names; no row values, no file name. resubmission_of links a corrected file to the batch it replaces. Written only by servicing.stage_import, commit_import and reject_import. Owner: servicing module.';
create trigger no_delete before delete on servicing.import_batches
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.import_batches
  for each statement execute function private.forbid_truncate();

create or replace function private.servicing_protect_batch()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_free text[];
begin
  if new.status is distinct from old.status then
    if not ((old.status = 'uploaded' and new.status in ('previewed', 'invalid', 'failed'))
         or (old.status = 'previewed' and new.status in ('committed', 'rejected', 'failed'))) then
      raise exception 'import batch transition % -> % is not allowed', old.status, new.status using errcode = 'P0001';
    end if;
  elsif old.status not in ('uploaded') then
    raise exception 'import batch is %, it can no longer change', old.status using errcode = 'P0001';
  end if;
  v_free := case old.status
    when 'uploaded' then array['status', 'updated_at', 'count_new', 'count_unchanged', 'count_duplicate', 'count_changed', 'count_conflict',
      'count_error', 'count_quarantined', 'count_ignored_older', 'reported_as_of_min', 'reported_as_of_max', 'failure_class', 'failed_at']
    else array['status', 'updated_at', 'committed_by', 'committed_at', 'rejected_by', 'rejected_at', 'reject_reason', 'failure_class',
      'failed_at', 'applied_counts', 'reported_as_of_min', 'reported_as_of_max'] end;
  if (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free) then
    raise exception 'import batch fields other than its progress are immutable' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.servicing_protect_batch() from public;
create trigger protect before update on servicing.import_batches
  for each row execute function private.servicing_protect_batch();

-- C3. Import rows: the stored preview. The normalised content is limited to the closed field set and is nulled for batches that
-- end invalid, rejected or failed.
create table servicing.import_rows (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  batch_id uuid not null,
  row_no integer not null check (row_no >= 1),
  -- The lender's own record id; null (with only its hash kept) once the batch is invalid, rejected or failed.
  source_record_id text check (source_record_id is null or length(source_record_id) between 1 and 100),
  source_record_id_sha256 text check (source_record_id_sha256 is null or source_record_id_sha256 ~ '^[0-9a-f]{64}$'),
  row_sha256 text check (row_sha256 is null or row_sha256 ~ '^[0-9a-f]{64}$'),
  normalised jsonb check (private.servicing_normalised_ok(normalised)),
  outcome text not null check (outcome in ('new', 'unchanged', 'duplicate', 'changed', 'conflict', 'error', 'quarantined')),
  error_codes text[] not null default '{}' check (error_codes <@ array[
    'row_not_object', 'unknown_field', 'missing_required', 'invalid_reference', 'borrower_ref_looks_personal', 'invalid_amount',
    'amount_not_positive', 'invalid_date', 'invalid_timestamp', 'timestamp_in_future', 'invalid_integer', 'invalid_status',
    'invalid_receipt_kind', 'incomplete_disbursement', 'incomplete_next_due', 'disbursed_exceeds_sanctioned',
    'reversal_reference_invalid', 'invalid_items', 'conflicting_duplicate', 'content_hash_mismatch',
    'application_not_found', 'application_ambiguous', 'application_not_ready', 'application_already_linked',
    'disbursement_evidence_incomplete', 'disbursement_date_in_future', 'unknown_loan', 'reversal_target_unknown', 'borrower_ref_mismatch']),
  field_names text[] not null default '{}' check (field_names <@ private.servicing_known_fields()),
  -- Non-blocking observations: overdue_total_mismatch, duplicate_row, ignored_older_report, ignored_older_sequence.
  flags text[] not null default '{}' check (flags <@ array['overdue_total_mismatch', 'duplicate_row', 'ignored_older_report', 'ignored_older_sequence']),
  -- What committing the batch actually did with this row.
  applied_result text check (applied_result is null or applied_result in ('new', 'changed', 'unchanged', 'conflict', 'duplicate', 'ignored_older')),
  applied_at timestamptz,
  foreign key (batch_id, lender_org_id) references servicing.import_batches (id, lender_org_id) on delete restrict,
  unique (batch_id, row_no),
  constraint blocking_rows_have_codes check (outcome not in ('error', 'quarantined') or cardinality(error_codes) > 0)
);
comment on table servicing.import_rows is
  'The stored preview of an import: one row per file record with its outcome (new, unchanged, duplicate, changed, conflict, error, quarantined), error codes and the NAMES of the fields at fault. normalised holds the record in canonical form limited to the closed field set (no personal-data field exists; borrower_ref is an opaque reference); it and the record id are set to null, keeping only hashes, when the batch ends invalid, rejected or failed. Write-once progress: only applied_result can be set after staging. Owner: servicing module.';
create trigger no_delete before delete on servicing.import_rows
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.import_rows
  for each statement execute function private.forbid_truncate();

create or replace function private.servicing_protect_row()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select b.status into v_status from servicing.import_batches b where b.id = new.batch_id;
  if v_status = 'uploaded' then
    if (new.id, new.lender_org_id, new.batch_id, new.row_no) is distinct from (old.id, old.lender_org_id, old.batch_id, old.row_no) then
      raise exception 'import row identity is immutable' using errcode = 'P0001';
    end if;
    return new;
  end if;
  -- After staging only two things may happen: the content is discarded (invalid, rejected, failed batches) or the applied
  -- result is recorded once at commit.
  if v_status in ('invalid', 'rejected', 'failed') then
    if (to_jsonb(new) - array['normalised', 'source_record_id', 'row_sha256']) is distinct from (to_jsonb(old) - array['normalised', 'source_record_id', 'row_sha256'])
       or new.normalised is not null or new.source_record_id is not null or new.row_sha256 is not null then
      raise exception 'a discarded import keeps no row values' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if v_status in ('previewed', 'committed') and old.applied_result is null and new.applied_result is not null
     and (to_jsonb(new) - array['applied_result', 'applied_at']) is not distinct from (to_jsonb(old) - array['applied_result', 'applied_at']) then
    return new;
  end if;
  raise exception 'import rows are append-only after staging' using errcode = 'P0001';
end
$$;
revoke all on function private.servicing_protect_row() from public;
create trigger protect before update on servicing.import_rows
  for each row execute function private.servicing_protect_row();

-- C4. What the lender reported (append-only). Every row carries its provenance.
create table servicing.balance_snapshots (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null,
  -- Udofin's own storage order for the loan (1, 2, ...), not a lender figure.
  version integer not null check (version > 0),
  -- The lender's monotonic sequence for the loan, when it supplies one.
  lender_sequence integer check (lender_sequence is null or lender_sequence >= 0),
  -- Everything below is exactly as reported. Udofin adds nothing up and corrects nothing.
  status servicing.loan_status not null,
  outstanding_principal_minor bigint check (outstanding_principal_minor is null or outstanding_principal_minor >= 0),
  overdue_principal_minor bigint check (overdue_principal_minor is null or overdue_principal_minor >= 0),
  overdue_interest_minor bigint check (overdue_interest_minor is null or overdue_interest_minor >= 0),
  penal_charges_minor bigint check (penal_charges_minor is null or penal_charges_minor >= 0),
  other_charges_minor bigint check (other_charges_minor is null or other_charges_minor >= 0),
  total_overdue_minor bigint check (total_overdue_minor is null or total_overdue_minor >= 0),
  next_due_on date,
  next_due_minor bigint check (next_due_minor is null or next_due_minor >= 0),
  days_past_due integer check (days_past_due is null or days_past_due >= 0),
  flags text[] not null default '{}' check (flags <@ array['overdue_total_mismatch']),
  -- Provenance.
  source_system servicing.source_system not null,
  import_batch_id uuid,
  source_record_id text not null check (length(source_record_id) between 1 and 100),
  reported_as_of timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by uuid references auth.users (id),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  foreign key (import_batch_id, lender_org_id) references servicing.import_batches (id, lender_org_id) on delete restrict,
  unique (loan_account_id, content_sha256),
  unique (loan_account_id, version),
  unique (id, lender_org_id),
  constraint next_due_both_or_neither check ((next_due_on is null) = (next_due_minor is null))
);
create unique index balance_snapshots_lender_sequence on servicing.balance_snapshots (loan_account_id, lender_sequence) where lender_sequence is not null;
create index balance_snapshots_latest on servicing.balance_snapshots (loan_account_id, reported_as_of desc, version desc);
create index balance_snapshots_batch on servicing.balance_snapshots (import_batch_id);
create index balance_snapshots_record on servicing.balance_snapshots (loan_account_id, source_record_id);
comment on table servicing.balance_snapshots is
  'Append-only copy of what the lender''s LMS reported for a loan: status, outstanding principal, overdue parts, penal and other charges, total overdue, next due, days past due AS REPORTED, with source lender, source system, import batch, source record id, reported_as_of (the lender''s time) and received_at (ours), sequence and content hash. Udofin never computes or restates any of these figures; a parts-versus-total mismatch is flagged, not fixed. A new report is a new row; nothing is ever updated or deleted. Written only by servicing.apply_lms_report. Owner: servicing module.';
create trigger append_only before update or delete on servicing.balance_snapshots
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.balance_snapshots
  for each statement execute function private.forbid_truncate();

create table servicing.lms_receipts (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null,
  kind text not null check (kind in ('receipt', 'reversal')),
  -- The lender's own id of this row; unique per lender.
  lms_receipt_ref text not null check (length(lms_receipt_ref) between 1 and 100),
  reverses_receipt_id uuid,
  reverses_receipt_ref text check (reverses_receipt_ref is null or length(reverses_receipt_ref) between 1 and 100),
  -- Always positive; a reversal is a separate row, never a negative amount.
  amount_minor bigint not null check (amount_minor > 0),
  value_date date not null,
  payment_mode text check (payment_mode is null or length(payment_mode) between 1 and 100),
  bank_reference text check (bank_reference is null or length(bank_reference) between 1 and 100),
  lender_sequence integer check (lender_sequence is null or lender_sequence >= 0),
  source_system servicing.source_system not null,
  import_batch_id uuid,
  source_record_id text not null check (length(source_record_id) between 1 and 100),
  reported_as_of timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by uuid references auth.users (id),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  foreign key (reverses_receipt_id, lender_org_id) references servicing.lms_receipts (id, lender_org_id) on delete restrict,
  foreign key (import_batch_id, lender_org_id) references servicing.import_batches (id, lender_org_id) on delete restrict,
  unique (lender_org_id, lms_receipt_ref),
  unique (loan_account_id, content_sha256),
  unique (id, lender_org_id),
  constraint reversal_references_receipt check ((kind = 'reversal') = (reverses_receipt_id is not null) and (kind = 'reversal') = (reverses_receipt_ref is not null))
);
create index lms_receipts_loan on servicing.lms_receipts (loan_account_id, value_date desc);
create index lms_receipts_reverses on servicing.lms_receipts (reverses_receipt_id);
create index lms_receipts_batch on servicing.lms_receipts (import_batch_id);
comment on table servicing.lms_receipts is
  'Append-only receipts and reversals the lender''s LMS posted against a loan: lender receipt ref (unique per lender), amount, value date, payment mode, bank reference (for example a UTR), with provenance. A reversal is its own row that references the receipt it reverses. Allocation of a receipt to principal, interest or charges is NOT stored: the import format v1 carries none and Udofin never allocates. A receipt appearing here says the LENDER posted it; it is not evidence that money reached a lender account. Written only by servicing.apply_lms_report. Owner: servicing module.';
create trigger append_only before update or delete on servicing.lms_receipts
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.lms_receipts
  for each statement execute function private.forbid_truncate();

create or replace function private.servicing_check_reversal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'reversal' and not exists (
    select 1 from servicing.lms_receipts o
    where o.id = new.reverses_receipt_id and o.lender_org_id = new.lender_org_id and o.kind = 'receipt'
      and o.loan_account_id = new.loan_account_id and o.lms_receipt_ref = new.reverses_receipt_ref
  ) then
    raise exception 'a reversal must reference a receipt of the same loan' using errcode = '23514', hint = 'reversal_target_invalid';
  end if;
  return new;
end
$$;
revoke all on function private.servicing_check_reversal() from public;
create trigger check_reversal before insert on servicing.lms_receipts
  for each row execute function private.servicing_check_reversal();

-- Schedule snapshots gain the same provenance. A new version supersedes the old one and never deletes it.
alter table servicing.schedule_snapshots
  add column reported_as_of timestamptz,
  add column content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  add column source servicing.source_system,
  add column import_batch_id uuid,
  add column source_record_id text check (source_record_id is null or length(source_record_id) between 1 and 100),
  add column lender_sequence integer check (lender_sequence is null or lender_sequence >= 0),
  add column recorded_by uuid references auth.users (id),
  add constraint schedule_snapshot_provenance check (
    content_sha256 is null or (reported_as_of is not null and source is not null and source_record_id is not null)),
  add constraint schedule_snapshots_batch_fk foreign key (import_batch_id, lender_org_id)
    references servicing.import_batches (id, lender_org_id) on delete restrict;
create unique index schedule_snapshots_content on servicing.schedule_snapshots (loan_account_id, content_sha256) where content_sha256 is not null;
create index schedule_snapshots_batch on servicing.schedule_snapshots (import_batch_id);
create index schedule_snapshots_latest on servicing.schedule_snapshots (loan_account_id, reported_as_of desc);
comment on column servicing.schedule_snapshots.reported_as_of is 'When the lender said this schedule was true (the lender''s time). Null only for rows that predate Phase 08a.';
comment on column servicing.schedule_snapshots.source is 'Where the schedule came from (file_import, manual_import, mock_lms, ...). Null only for rows that predate Phase 08a.';
comment on column servicing.schedule_snapshots.content_sha256 is 'Hash of the canonical report; unique per loan, so a re-sent schedule is not stored twice.';

-- C5. Anomalies: flagged, stored, never corrected.
create table servicing.sync_anomalies (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null,
  kind text not null check (kind in ('status_regression', 'terminal_status_changed', 'outstanding_rise_without_charge', 'overdue_total_mismatch',
    'sanctioned_amount_changed', 'disbursement_evidence_differs', 'reversal_exceeds_receipt', 'older_report_ignored', 'older_sequence_ignored')),
  severity text not null check (severity in ('info', 'warning')),
  snapshot_id uuid,
  receipt_id uuid,
  previous_status servicing.loan_status,
  reported_status servicing.loan_status,
  previous_amount_minor bigint check (previous_amount_minor is null or previous_amount_minor >= 0),
  reported_amount_minor bigint check (reported_amount_minor is null or reported_amount_minor >= 0),
  source_system servicing.source_system not null,
  import_batch_id uuid,
  source_record_id text not null check (length(source_record_id) between 1 and 100),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  reported_as_of timestamptz not null,
  detected_at timestamptz not null default clock_timestamp(),
  detected_by uuid references auth.users (id),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  foreign key (snapshot_id, lender_org_id) references servicing.balance_snapshots (id, lender_org_id) on delete restrict,
  foreign key (receipt_id, lender_org_id) references servicing.lms_receipts (id, lender_org_id) on delete restrict,
  foreign key (import_batch_id, lender_org_id) references servicing.import_batches (id, lender_org_id) on delete restrict,
  unique (loan_account_id, content_sha256, kind),
  constraint severity_matches_kind check ((kind in ('older_report_ignored', 'older_sequence_ignored')) = (severity = 'info'))
);
create index sync_anomalies_loan on servicing.sync_anomalies (loan_account_id, detected_at desc);
create index sync_anomalies_snapshot on servicing.sync_anomalies (snapshot_id);
create index sync_anomalies_receipt on servicing.sync_anomalies (receipt_id);
create index sync_anomalies_batch on servicing.sync_anomalies (import_batch_id);
comment on table servicing.sync_anomalies is
  'Append-only flags raised while storing what the lender reported: a status moving backwards, an outstanding amount that rises without a reported charge, overdue parts that do not add up to the stated total, a changed sanctioned amount or disbursement evidence, a reversal larger than its receipt, and older reports that were ignored and counted. The data is stored exactly as reported and never corrected; the flag is for the lender, who corrects by sending a new report. Never readable by borrowers. Written only by servicing.apply_lms_report. Owner: servicing module.';
create trigger append_only before update or delete on servicing.sync_anomalies
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.sync_anomalies
  for each statement execute function private.forbid_truncate();

-- C6. Conflicts: a different payload for a record the lender already sent. Queued for a lender user; code never resolves them.
create table servicing.sync_conflicts (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null,
  record_type text not null check (record_type in ('loan', 'receipt', 'schedule')),
  conflict_reason text not null check (conflict_reason in ('same_record_different_content', 'same_time_different_content', 'sequence_reused', 'receipt_differs')),
  source_record_id text not null check (length(source_record_id) between 1 and 100),
  existing_ref_id uuid,
  existing_content_sha256 text not null check (existing_content_sha256 ~ '^[0-9a-f]{64}$'),
  existing_reported_as_of timestamptz not null,
  incoming_content_sha256 text not null check (incoming_content_sha256 ~ '^[0-9a-f]{64}$'),
  incoming_reported_as_of timestamptz not null,
  -- The refused version in canonical form (closed field set, no personal data), so the lender can see what it was.
  incoming_report jsonb not null check (private.servicing_normalised_ok(incoming_report)),
  source_system servicing.source_system not null,
  import_batch_id uuid,
  received_at timestamptz not null default clock_timestamp(),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  acknowledged_by uuid references auth.users (id),
  acknowledged_at timestamptz,
  -- Resolution marks which version the lender confirms. It NEVER rewrites history: both versions stay as they were.
  resolved_by uuid references auth.users (id),
  resolved_at timestamptz,
  confirmed_version text check (confirmed_version is null or confirmed_version in ('existing', 'incoming')),
  resolution_note text check (resolution_note is null or length(trim(resolution_note)) between 10 and 1000),
  evidence_reviewed jsonb check (evidence_reviewed is null or private.feature_evidence_ok(evidence_reviewed)),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  foreign key (import_batch_id, lender_org_id) references servicing.import_batches (id, lender_org_id) on delete restrict,
  unique (loan_account_id, record_type, existing_content_sha256, incoming_content_sha256),
  constraint acknowledged_has_actor check (status = 'open' or (acknowledged_by is not null and acknowledged_at is not null)),
  constraint resolved_has_everything check (status <> 'resolved' or (resolved_by is not null and resolved_at is not null and confirmed_version is not null
    and resolution_note is not null and evidence_reviewed is not null and evidence_reviewed <> '{}'::jsonb)),
  constraint open_has_no_resolution check (status = 'resolved' or (resolved_by is null and confirmed_version is null and resolution_note is null))
);
create index sync_conflicts_queue on servicing.sync_conflicts (lender_org_id, status, received_at);
create index sync_conflicts_batch on servicing.sync_conflicts (import_batch_id);
comment on table servicing.sync_conflicts is
  'Queue of reports that disagree with what the lender already sent: the same source record id with different content and the same or an older reported_as_of, the same instant or lender sequence with different content, or a receipt re-sent with different figures. Status open, acknowledged, resolved. The refused version is kept in canonical form. A lender user resolves a conflict with a note and the evidence they reviewed by marking which version the lender confirms; code never resolves one and resolution never rewrites or deletes either version (a correction arrives as a newer report). Never readable by borrowers. Owner: servicing module.';
create trigger no_delete before delete on servicing.sync_conflicts
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.sync_conflicts
  for each statement execute function private.forbid_truncate();

create or replace function private.servicing_protect_conflict()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_free text[] := array['status', 'acknowledged_by', 'acknowledged_at', 'resolved_by', 'resolved_at', 'confirmed_version', 'resolution_note', 'evidence_reviewed'];
begin
  if not ((old.status = 'open' and new.status = 'acknowledged') or (old.status = 'acknowledged' and new.status = 'resolved')) then
    raise exception 'conflict transition % -> % is not allowed', old.status, new.status using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free) then
    raise exception 'a conflict''s content is immutable; only its handling status changes' using errcode = 'P0001';
  end if;
  if old.status = 'acknowledged' and (new.acknowledged_by, new.acknowledged_at) is distinct from (old.acknowledged_by, old.acknowledged_at) then
    raise exception 'the acknowledgement cannot change' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.servicing_protect_conflict() from public;
create trigger protect before update on servicing.sync_conflicts
  for each row execute function private.servicing_protect_conflict();

-- C7. Quarantine: reports that could not be tied to a loan or application. Nothing is created from them.
create table servicing.sync_quarantine (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  record_type text not null check (record_type in ('loan', 'receipt', 'schedule')),
  reason_code text not null check (reason_code in ('application_not_found', 'application_ambiguous', 'application_not_ready', 'application_already_linked',
    'disbursement_evidence_incomplete', 'disbursement_date_in_future', 'unknown_loan', 'reversal_target_unknown', 'borrower_ref_mismatch')),
  lms_loan_ref text not null check (length(lms_loan_ref) between 1 and 100),
  source_system servicing.source_system not null,
  import_batch_id uuid,
  source_record_id text not null check (length(source_record_id) between 1 and 100),
  reported_as_of timestamptz not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default clock_timestamp(),
  recorded_by uuid references auth.users (id),
  foreign key (import_batch_id, lender_org_id) references servicing.import_batches (id, lender_org_id) on delete restrict,
  unique (lender_org_id, content_sha256, reason_code)
);
create index sync_quarantine_lender on servicing.sync_quarantine (lender_org_id, received_at desc);
create index sync_quarantine_batch on servicing.sync_quarantine (import_batch_id);
comment on table servicing.sync_quarantine is
  'Append-only record that a report was refused and nothing was created from it: unknown or foreign application reference, a borrower reference that does not belong to the loan, application not ready, disbursement evidence incomplete, unknown loan, unknown reversal target. Only references, the reason class, hashes and times are kept, never figures. When the cause is fixed the lender sends the report again. Never readable by borrowers. Written only by servicing.apply_lms_report. Owner: servicing module.';
create trigger append_only before update or delete on servicing.sync_quarantine
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.sync_quarantine
  for each statement execute function private.forbid_truncate();

-- Application lookups by the lender's own reference (borrower_ref in a loan report).
create index applications_lender_reference on lending.applications (lender_org_id, lender_reference) where lender_reference is not null;
create index application_routing_lender_ref on lending.application_routing (lender_org_id, lender_application_ref) where lender_application_ref is not null;

-- ---------------------------------------------------------------------------------------------
-- D. Row level security and grants. Lenders read their own rows (loan.read; platform grantees through the same
--    mechanism); borrowers have no policy on any of these tables and read through servicing.my_loans / my_loan only.
--    Nobody holds INSERT, UPDATE or DELETE: the definer functions below are the only writers. service_role gets SELECT only.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['lms_connections', 'import_batches', 'import_rows', 'balance_snapshots', 'lms_receipts', 'sync_anomalies',
                           'sync_conflicts', 'sync_quarantine']
  loop
    execute format('alter table servicing.%I enable row level security', t);
    execute format('alter table servicing.%I force row level security', t);
    execute format('create policy %I on servicing.%I for select to authenticated using (lender_org_id in (select private.orgs_with_permission(%L)))',
                   t || '_lender_read', t, 'loan.read');
    execute format('revoke all on servicing.%I from service_role', t);
    execute format('grant select on servicing.%I to service_role', t);
    execute format('grant select on servicing.%I to authenticated', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- E. The single implementation behind every source of reports (file, manual, mock, REST later)
-- ---------------------------------------------------------------------------------------------

-- A source may be used only through an ACTIVE connection of the matching kind. A file connection also allows manual entry
-- (a manual entry is a one-record file); a manual connection does not allow files; mock only under the guard.
create or replace function private.servicing_require_connection(p_lender uuid, p_source servicing.source_system)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_c servicing.lms_connections;
begin
  select * into v_c from servicing.lms_connections c where c.lender_org_id = p_lender;
  if not found or v_c.status <> 'active' or not (
       (p_source = 'file_import' and v_c.kind = 'file_import')
    or (p_source = 'manual_import' and v_c.kind in ('file_import', 'manual'))
    or (p_source = 'mock_lms' and v_c.kind = 'mock')) then
    raise exception 'there is no active connection for this source' using errcode = '55000', hint = 'connection_not_active';
  end if;
  -- The guard again at use time: a mock connection is unusable in a session that does not allow mock providers.
  perform private.assert_provider_mode_allowed(v_c.provider_mode);
end
$$;
revoke all on function private.servicing_require_connection(uuid, servicing.source_system) from public;

-- Applications that a borrower_ref can mean for this lender: the Udofin application id, or the lender's own application
-- reference. Several matches mean the reference is ambiguous; none (or only another lender's) means unknown.
create or replace function private.servicing_find_application(p_lender uuid, p_ref text)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if p_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select array_agg(a.id) into v_ids from lending.applications a where a.id = p_ref::uuid and a.lender_org_id = p_lender;
  end if;
  if v_ids is null then
    select array_agg(x.id) into v_ids from (
      select a.id from lending.applications a where a.lender_org_id = p_lender and a.lender_reference = p_ref
      union
      select r.application_id from lending.application_routing r where r.lender_org_id = p_lender and r.lender_application_ref = p_ref
    ) x;
  end if;
  return coalesce(v_ids, '{}'::uuid[]);
end
$$;
revoke all on function private.servicing_find_application(uuid, text) from public;

create or replace function private.servicing_quarantine(
  p_lender uuid, p_type text, p_canon jsonb, p_hash text, p_source servicing.source_system, p_batch uuid, p_reason text, p_dry boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not p_dry then
    insert into servicing.sync_quarantine (lender_org_id, record_type, reason_code, lms_loan_ref, source_system, import_batch_id, source_record_id,
                                           reported_as_of, content_sha256, recorded_by)
    values (p_lender, p_type, p_reason, p_canon ->> 'lms_loan_ref', p_source, p_batch, p_canon ->> 'source_record_id',
            (p_canon ->> 'reported_as_of')::timestamptz, p_hash, (select auth.uid()))
    on conflict (lender_org_id, content_sha256, reason_code) do nothing;
  end if;
  return jsonb_build_object('outcome', 'quarantined', 'reason', p_reason);
end
$$;
revoke all on function private.servicing_quarantine(uuid, text, jsonb, text, servicing.source_system, uuid, text, boolean) from public;

create or replace function private.servicing_flag(
  p_lender uuid, p_loan uuid, p_kind text, p_snapshot uuid, p_receipt uuid, p_prev_status servicing.loan_status, p_rep_status servicing.loan_status,
  p_prev_amount bigint, p_rep_amount bigint, p_source servicing.source_system, p_batch uuid, p_srid text, p_hash text, p_reported timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into servicing.sync_anomalies (lender_org_id, loan_account_id, kind, severity, snapshot_id, receipt_id, previous_status, reported_status,
    previous_amount_minor, reported_amount_minor, source_system, import_batch_id, source_record_id, content_sha256, reported_as_of, detected_by)
  values (p_lender, p_loan, p_kind, case when p_kind in ('older_report_ignored', 'older_sequence_ignored') then 'info' else 'warning' end,
          p_snapshot, p_receipt, p_prev_status, p_rep_status, p_prev_amount, p_rep_amount, p_source, p_batch, p_srid, p_hash, p_reported,
          (select auth.uid()))
  on conflict (loan_account_id, content_sha256, kind) do nothing
$$;
revoke all on function private.servicing_flag(uuid, uuid, text, uuid, uuid, servicing.loan_status, servicing.loan_status, bigint, bigint, servicing.source_system, uuid, text, text, timestamptz) from public;

create or replace function private.servicing_conflict(
  p_lender uuid, p_loan uuid, p_type text, p_reason text, p_srid text, p_existing_id uuid, p_existing_hash text, p_existing_reported timestamptz,
  p_hash text, p_reported timestamptz, p_canon jsonb, p_source servicing.source_system, p_batch uuid, p_dry boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_dry then
    return jsonb_build_object('outcome', 'conflict', 'reason', p_reason);
  end if;
  insert into servicing.sync_conflicts (lender_org_id, loan_account_id, record_type, conflict_reason, source_record_id, existing_ref_id,
    existing_content_sha256, existing_reported_as_of, incoming_content_sha256, incoming_reported_as_of, incoming_report, source_system, import_batch_id)
  values (p_lender, p_loan, p_type, p_reason, p_srid, p_existing_id, p_existing_hash, p_existing_reported, p_hash, p_reported, p_canon, p_source, p_batch)
  on conflict (loan_account_id, record_type, existing_content_sha256, incoming_content_sha256) do nothing
  returning id into v_id;
  if v_id is not null then
    perform ops.enqueue_event('servicing.sync_conflict.opened', jsonb_build_object('conflict_id', v_id, 'lender_org_id', p_lender), null,
                              'sync-conflict:' || v_id::text);
  else
    select c.id into v_id from servicing.sync_conflicts c
    where c.loan_account_id = p_loan and c.record_type = p_type and c.existing_content_sha256 = p_existing_hash and c.incoming_content_sha256 = p_hash;
  end if;
  return jsonb_build_object('outcome', 'conflict', 'reason', p_reason, 'conflict_id', v_id, 'loan_account_id', p_loan);
end
$$;
revoke all on function private.servicing_conflict(uuid, uuid, text, text, text, uuid, text, timestamptz, text, timestamptz, jsonb, servicing.source_system, uuid, boolean) from public;

-- Loan report. Creates the loan account only when the application matches and the disbursement evidence is complete;
-- otherwise quarantine. Everything else is stored as reported and flagged, never corrected.
create or replace function private.servicing_apply_loan(
  p_lender uuid, p_canon jsonb, p_hash text, p_source servicing.source_system, p_batch uuid, p_dry boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref text := p_canon ->> 'lms_loan_ref';
  v_srid text := p_canon ->> 'source_record_id';
  v_rep timestamptz := (p_canon ->> 'reported_as_of')::timestamptz;
  v_seq integer := (p_canon ->> 'sequence')::integer;
  v_status servicing.loan_status := (p_canon ->> 'status')::servicing.loan_status;
  v_sanct bigint := private.servicing_try_money(p_canon ->> 'sanctioned_amount');
  v_outstanding bigint := private.servicing_try_money(p_canon ->> 'outstanding_principal');
  v_penal bigint := private.servicing_try_money(p_canon ->> 'penal_charges');
  v_other bigint := private.servicing_try_money(p_canon ->> 'other_charges');
  v_loan servicing.loan_accounts;
  v_app lending.applications;
  v_apps uuid[];
  v_same servicing.balance_snapshots;
  v_sameid servicing.balance_snapshots;
  v_seqrow servicing.balance_snapshots;
  v_prev servicing.balance_snapshots;
  v_snap servicing.balance_snapshots;
  v_created boolean := false;
  v_kinds text[] := '{}';
  v_version integer;
  v_prev_status servicing.loan_status;
  v_uid uuid := (select auth.uid());
  v_disb_date date;
begin
  if not p_dry then
    perform pg_advisory_xact_lock(hashtextextended('servicing:' || p_lender::text || ':' || v_ref, 0));
  end if;
  select * into v_loan from servicing.loan_accounts la where la.lender_org_id = p_lender and la.lms_loan_ref = v_ref;

  if not found then
    v_apps := private.servicing_find_application(p_lender, p_canon ->> 'borrower_ref');
    if cardinality(v_apps) = 0 then
      return private.servicing_quarantine(p_lender, 'loan', p_canon, p_hash, p_source, p_batch, 'application_not_found', p_dry);
    elsif cardinality(v_apps) > 1 then
      return private.servicing_quarantine(p_lender, 'loan', p_canon, p_hash, p_source, p_batch, 'application_ambiguous', p_dry);
    end if;
    select * into v_app from lending.applications a where a.id = v_apps[1] and a.lender_org_id = p_lender;
    if v_app.status not in ('agreement_executed', 'disbursement_pending', 'disbursed') then
      return private.servicing_quarantine(p_lender, 'loan', p_canon, p_hash, p_source, p_batch, 'application_not_ready', p_dry);
    end if;
    if exists (select 1 from servicing.loan_accounts la where la.application_id = v_app.id) then
      return private.servicing_quarantine(p_lender, 'loan', p_canon, p_hash, p_source, p_batch, 'application_already_linked', p_dry);
    end if;
    if not (p_canon ? 'disbursed_amount' and p_canon ? 'disbursement_ref' and p_canon ? 'disbursement_date') then
      return private.servicing_quarantine(p_lender, 'loan', p_canon, p_hash, p_source, p_batch, 'disbursement_evidence_incomplete', p_dry);
    end if;
    v_disb_date := (p_canon ->> 'disbursement_date')::date;
    if v_disb_date > (now() at time zone 'Asia/Kolkata')::date then
      return private.servicing_quarantine(p_lender, 'loan', p_canon, p_hash, p_source, p_batch, 'disbursement_date_in_future', p_dry);
    end if;
    if p_dry then
      return jsonb_build_object('outcome', 'new');
    end if;
    -- The application is locked so two reports for the same application cannot both create a loan.
    perform 1 from lending.applications a where a.id = v_app.id for update;
    insert into servicing.loan_accounts (lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor,
                                         disbursed_amount_minor, disbursed_at, disbursement_reference)
    values (p_lender, v_app.id, v_app.borrower_id, p_source, v_ref, v_status, v_sanct,
            private.servicing_try_money(p_canon ->> 'disbursed_amount'), (v_disb_date::text || ' 00:00:00+05:30')::timestamptz,
            p_canon ->> 'disbursement_ref')
    returning * into v_loan;
    v_created := true;
    -- The lender's report is the disbursement evidence. The application follows: the lender-allowed step here, the
    -- system-only final step (disbursed) by whoever runs as the system (this call, or servicing.complete_disbursements).
    perform set_config('udofin.transition_reason', 'lms_report', true);
    if v_app.status = 'agreement_executed' then
      update lending.applications set status = 'disbursement_pending' where id = v_app.id;
      v_app.status := 'disbursement_pending';
    end if;
    if v_app.status = 'disbursement_pending' and private.current_actor() = 'system' then
      update lending.applications set status = 'disbursed' where id = v_app.id;
    end if;
    perform set_config('udofin.transition_reason', '', true);
  else
    select * into v_same from servicing.balance_snapshots s where s.loan_account_id = v_loan.id and s.content_sha256 = p_hash;
    if found then
      return jsonb_build_object('outcome', 'unchanged', 'loan_account_id', v_loan.id, 'snapshot_id', v_same.id);
    end if;
    -- The borrower reference must still point at the application this loan was created from; a report that names another
    -- application (or none) is not stored against this borrower's loan.
    if private.servicing_find_application(p_lender, p_canon ->> 'borrower_ref') is distinct from array[v_loan.application_id] then
      return private.servicing_quarantine(p_lender, 'loan', p_canon, p_hash, p_source, p_batch, 'borrower_ref_mismatch', p_dry);
    end if;
    select * into v_sameid from servicing.balance_snapshots s
    where s.loan_account_id = v_loan.id and s.source_record_id = v_srid order by s.version desc limit 1;
    if found and v_rep <= v_sameid.reported_as_of then
      return private.servicing_conflict(p_lender, v_loan.id, 'loan', 'same_record_different_content', v_srid, v_sameid.id, v_sameid.content_sha256,
        v_sameid.reported_as_of, p_hash, v_rep, p_canon, p_source, p_batch, p_dry);
    end if;
    if v_seq is not null then
      select * into v_seqrow from servicing.balance_snapshots s where s.loan_account_id = v_loan.id and s.lender_sequence = v_seq;
      if found then
        return private.servicing_conflict(p_lender, v_loan.id, 'loan', 'sequence_reused', v_srid, v_seqrow.id, v_seqrow.content_sha256,
          v_seqrow.reported_as_of, p_hash, v_rep, p_canon, p_source, p_batch, p_dry);
      end if;
    end if;
    select * into v_prev from servicing.balance_snapshots s where s.loan_account_id = v_loan.id order by s.reported_as_of desc, s.version desc limit 1;
    if found then
      if v_rep < v_prev.reported_as_of then
        if not p_dry then
          perform private.servicing_flag(p_lender, v_loan.id, 'older_report_ignored', null, null, null, null, null, null, p_source, p_batch, v_srid, p_hash, v_rep);
        end if;
        return jsonb_build_object('outcome', 'unchanged', 'ignored', 'older_report', 'loan_account_id', v_loan.id);
      elsif v_rep = v_prev.reported_as_of then
        return private.servicing_conflict(p_lender, v_loan.id, 'loan', 'same_time_different_content', v_srid, v_prev.id, v_prev.content_sha256,
          v_prev.reported_as_of, p_hash, v_rep, p_canon, p_source, p_batch, p_dry);
      elsif v_seq is not null and v_prev.lender_sequence is not null and v_seq < v_prev.lender_sequence then
        if not p_dry then
          perform private.servicing_flag(p_lender, v_loan.id, 'older_sequence_ignored', null, null, null, null, null, null, p_source, p_batch, v_srid, p_hash, v_rep);
        end if;
        return jsonb_build_object('outcome', 'unchanged', 'ignored', 'older_sequence', 'loan_account_id', v_loan.id);
      end if;
    end if;
    if p_dry then
      return jsonb_build_object('outcome', case when v_prev.id is null then 'new' else 'changed' end, 'loan_account_id', v_loan.id);
    end if;
  end if;

  -- Store the report exactly as received.
  select coalesce(max(s.version), 0) + 1 into v_version from servicing.balance_snapshots s where s.loan_account_id = v_loan.id;
  insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, lender_sequence, status, outstanding_principal_minor,
    overdue_principal_minor, overdue_interest_minor, penal_charges_minor, other_charges_minor, total_overdue_minor, next_due_on, next_due_minor,
    days_past_due, flags, source_system, import_batch_id, source_record_id, reported_as_of, content_sha256, recorded_by)
  values (p_lender, v_loan.id, v_version, v_seq, v_status, v_outstanding,
    private.servicing_try_money(p_canon ->> 'overdue_principal'), private.servicing_try_money(p_canon ->> 'overdue_interest'), v_penal, v_other,
    private.servicing_try_money(p_canon ->> 'total_overdue'), (p_canon ->> 'next_due_date')::date, private.servicing_try_money(p_canon ->> 'next_due_amount'),
    (p_canon ->> 'days_past_due')::integer,
    case when p_canon ? 'overdue_principal' and p_canon ? 'overdue_interest' and p_canon ? 'penal_charges' and p_canon ? 'other_charges' and p_canon ? 'total_overdue'
              and private.servicing_try_money(p_canon ->> 'overdue_principal') + private.servicing_try_money(p_canon ->> 'overdue_interest') + v_penal + v_other
                  <> private.servicing_try_money(p_canon ->> 'total_overdue')
         then array['overdue_total_mismatch'] else '{}'::text[] end,
    p_source, p_batch, v_srid, v_rep, p_hash, v_uid)
  returning * into v_snap;

  -- Flags. They are stored next to the data and never change it.
  v_prev_status := coalesce(v_prev.status, v_loan.status);
  if v_prev_status <> 'active' and v_status = 'active' then
    v_kinds := v_kinds || 'status_regression'::text;
    perform private.servicing_flag(p_lender, v_loan.id, 'status_regression', v_snap.id, null, v_prev_status, v_status, null, null, p_source, p_batch, v_srid, p_hash, v_rep);
  elsif v_prev_status <> 'active' and v_status <> v_prev_status then
    v_kinds := v_kinds || 'terminal_status_changed'::text;
    perform private.servicing_flag(p_lender, v_loan.id, 'terminal_status_changed', v_snap.id, null, v_prev_status, v_status, null, null, p_source, p_batch, v_srid, p_hash, v_rep);
  end if;
  if v_prev.id is not null and v_prev.outstanding_principal_minor is not null and v_outstanding is not null
     and v_outstanding > v_prev.outstanding_principal_minor
     and not (coalesce(v_penal, 0) > coalesce(v_prev.penal_charges_minor, 0) or coalesce(v_other, 0) > coalesce(v_prev.other_charges_minor, 0)) then
    v_kinds := v_kinds || 'outstanding_rise_without_charge'::text;
    perform private.servicing_flag(p_lender, v_loan.id, 'outstanding_rise_without_charge', v_snap.id, null, null, null,
      v_prev.outstanding_principal_minor, v_outstanding, p_source, p_batch, v_srid, p_hash, v_rep);
  end if;
  if 'overdue_total_mismatch' = any (v_snap.flags) then
    v_kinds := v_kinds || 'overdue_total_mismatch'::text;
    perform private.servicing_flag(p_lender, v_loan.id, 'overdue_total_mismatch', v_snap.id, null, null, null, v_snap.total_overdue_minor, v_snap.total_overdue_minor,
      p_source, p_batch, v_srid, p_hash, v_rep);
  end if;
  if not v_created and v_sanct <> v_loan.sanctioned_amount_minor then
    v_kinds := v_kinds || 'sanctioned_amount_changed'::text;
    perform private.servicing_flag(p_lender, v_loan.id, 'sanctioned_amount_changed', v_snap.id, null, null, null, v_loan.sanctioned_amount_minor, v_sanct,
      p_source, p_batch, v_srid, p_hash, v_rep);
  end if;
  if not v_created and p_canon ? 'disbursed_amount' and (
       private.servicing_try_money(p_canon ->> 'disbursed_amount') is distinct from v_loan.disbursed_amount_minor
       or (p_canon ->> 'disbursement_ref') is distinct from v_loan.disbursement_reference
       or (p_canon ->> 'disbursement_date')::date is distinct from (v_loan.disbursed_at at time zone 'Asia/Kolkata')::date) then
    v_kinds := v_kinds || 'disbursement_evidence_differs'::text;
    perform private.servicing_flag(p_lender, v_loan.id, 'disbursement_evidence_differs', v_snap.id, null, null, null, v_loan.disbursed_amount_minor,
      private.servicing_try_money(p_canon ->> 'disbursed_amount'), p_source, p_batch, v_srid, p_hash, v_rep);
  end if;

  -- The loan account follows the lender forward only: active to a terminal status. A terminal status is never reopened by
  -- a report (the regression is flagged above and payments stay stopped), and a changed sanctioned amount is applied only
  -- when it still covers the recorded disbursement (the change is in loan_account_events, and flagged). Disbursement
  -- evidence is permanent and is never rewritten.
  update servicing.loan_accounts la set
    status = case when la.status = 'active' and v_status <> 'active' then v_status else la.status end,
    sanctioned_amount_minor = case when v_sanct <> la.sanctioned_amount_minor and (la.disbursed_amount_minor is null or v_sanct >= la.disbursed_amount_minor)
                                   then v_sanct else la.sanctioned_amount_minor end,
    last_synced_at = clock_timestamp()
  where la.id = v_loan.id;

  return jsonb_build_object('outcome', case when v_created or v_prev.id is null then 'new' else 'changed' end,
    'loan_account_id', v_loan.id, 'snapshot_id', v_snap.id, 'created', v_created, 'anomalies', to_jsonb(v_kinds));
end
$$;
revoke all on function private.servicing_apply_loan(uuid, jsonb, text, servicing.source_system, uuid, boolean) from public;

create or replace function private.servicing_apply_receipt(
  p_lender uuid, p_canon jsonb, p_hash text, p_source servicing.source_system, p_batch uuid, p_dry boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref text := p_canon ->> 'lms_loan_ref';
  v_rref text := p_canon ->> 'lms_receipt_ref';
  v_kind text := p_canon ->> 'receipt_kind';
  v_srid text := p_canon ->> 'source_record_id';
  v_rep timestamptz := (p_canon ->> 'reported_as_of')::timestamptz;
  v_amount bigint := private.servicing_try_money(p_canon ->> 'amount');
  v_loan servicing.loan_accounts;
  v_ex servicing.lms_receipts;
  v_orig servicing.lms_receipts;
  v_new servicing.lms_receipts;
  v_reversed bigint;
  v_has_orig boolean;
begin
  select * into v_loan from servicing.loan_accounts la where la.lender_org_id = p_lender and la.lms_loan_ref = v_ref;
  if not found then
    return private.servicing_quarantine(p_lender, 'receipt', p_canon, p_hash, p_source, p_batch, 'unknown_loan', p_dry);
  end if;
  if not p_dry then
    perform pg_advisory_xact_lock(hashtextextended('servicing-receipt:' || p_lender::text || ':' || v_rref, 0));
  end if;
  select * into v_ex from servicing.lms_receipts r where r.lender_org_id = p_lender and r.lms_receipt_ref = v_rref;
  if found then
    -- The same receipt again (even re-sent later) is unchanged; the same lender receipt ref with other figures is a conflict.
    if v_ex.loan_account_id = v_loan.id and (v_ex.kind, v_ex.reverses_receipt_ref, v_ex.amount_minor, v_ex.value_date, v_ex.payment_mode, v_ex.bank_reference)
       is not distinct from (v_kind, p_canon ->> 'reverses_receipt_ref', v_amount, (p_canon ->> 'value_date')::date, p_canon ->> 'payment_mode', p_canon ->> 'bank_reference') then
      return jsonb_build_object('outcome', 'unchanged', 'loan_account_id', v_loan.id, 'receipt_id', v_ex.id);
    end if;
    return private.servicing_conflict(p_lender, v_loan.id, 'receipt', 'receipt_differs', v_srid, v_ex.id, v_ex.content_sha256, v_ex.reported_as_of,
      p_hash, v_rep, p_canon, p_source, p_batch, p_dry);
  end if;
  if v_kind = 'reversal' then
    select * into v_orig from servicing.lms_receipts r
    where r.lender_org_id = p_lender and r.lms_receipt_ref = p_canon ->> 'reverses_receipt_ref' and r.kind = 'receipt' and r.loan_account_id = v_loan.id;
    v_has_orig := found;
    if not v_has_orig and p_dry and p_batch is not null then
      v_has_orig := exists (
        select 1 from servicing.import_rows ir
        where ir.batch_id = p_batch and ir.normalised ->> 'receipt_kind' = 'receipt' and ir.normalised ->> 'lms_receipt_ref' = p_canon ->> 'reverses_receipt_ref'
          and ir.normalised ->> 'lms_loan_ref' = v_ref and ir.outcome in ('new', 'unchanged', 'changed', 'conflict'));
    end if;
    if not v_has_orig then
      return private.servicing_quarantine(p_lender, 'receipt', p_canon, p_hash, p_source, p_batch, 'reversal_target_unknown', p_dry);
    end if;
  end if;
  if p_dry then
    return jsonb_build_object('outcome', 'new', 'loan_account_id', v_loan.id);
  end if;
  insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, reverses_receipt_id, reverses_receipt_ref, amount_minor, value_date,
    payment_mode, bank_reference, lender_sequence, source_system, import_batch_id, source_record_id, reported_as_of, content_sha256, recorded_by)
  values (p_lender, v_loan.id, v_kind, v_rref, v_orig.id, p_canon ->> 'reverses_receipt_ref', v_amount, (p_canon ->> 'value_date')::date,
          p_canon ->> 'payment_mode', p_canon ->> 'bank_reference', (p_canon ->> 'sequence')::integer, p_source, p_batch, v_srid, v_rep, p_hash, (select auth.uid()))
  returning * into v_new;
  if v_kind = 'reversal' then
    select coalesce(sum(r.amount_minor), 0) into v_reversed from servicing.lms_receipts r
    where r.reverses_receipt_id = v_orig.id and r.lender_org_id = p_lender;
    if v_reversed > v_orig.amount_minor then
      perform private.servicing_flag(p_lender, v_loan.id, 'reversal_exceeds_receipt', null, v_new.id, null, null, v_orig.amount_minor, v_reversed,
        p_source, p_batch, v_srid, p_hash, v_rep);
    end if;
  end if;
  update servicing.loan_accounts la set last_synced_at = clock_timestamp() where la.id = v_loan.id;
  return jsonb_build_object('outcome', 'new', 'loan_account_id', v_loan.id, 'receipt_id', v_new.id);
end
$$;
revoke all on function private.servicing_apply_receipt(uuid, jsonb, text, servicing.source_system, uuid, boolean) from public;

create or replace function private.servicing_apply_schedule(
  p_lender uuid, p_canon jsonb, p_hash text, p_source servicing.source_system, p_batch uuid, p_dry boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref text := p_canon ->> 'lms_loan_ref';
  v_srid text := p_canon ->> 'source_record_id';
  v_rep timestamptz := (p_canon ->> 'reported_as_of')::timestamptz;
  v_seq integer := (p_canon ->> 'sequence')::integer;
  v_loan servicing.loan_accounts;
  v_same servicing.schedule_snapshots;
  v_sameid servicing.schedule_snapshots;
  v_seqrow servicing.schedule_snapshots;
  v_prev servicing.schedule_snapshots;
  v_snap servicing.schedule_snapshots;
  v_version integer;
begin
  select * into v_loan from servicing.loan_accounts la where la.lender_org_id = p_lender and la.lms_loan_ref = v_ref;
  if not found then
    return private.servicing_quarantine(p_lender, 'schedule', p_canon, p_hash, p_source, p_batch, 'unknown_loan', p_dry);
  end if;
  if not p_dry then
    perform pg_advisory_xact_lock(hashtextextended('servicing-schedule:' || p_lender::text || ':' || v_ref, 0));
  end if;
  select * into v_same from servicing.schedule_snapshots s where s.loan_account_id = v_loan.id and s.content_sha256 = p_hash;
  if found then
    return jsonb_build_object('outcome', 'unchanged', 'loan_account_id', v_loan.id, 'schedule_snapshot_id', v_same.id);
  end if;
  select * into v_sameid from servicing.schedule_snapshots s
  where s.loan_account_id = v_loan.id and s.source_record_id = v_srid order by s.version desc limit 1;
  if found and v_rep <= v_sameid.reported_as_of then
    return private.servicing_conflict(p_lender, v_loan.id, 'schedule', 'same_record_different_content', v_srid, v_sameid.id, v_sameid.content_sha256,
      v_sameid.reported_as_of, p_hash, v_rep, p_canon, p_source, p_batch, p_dry);
  end if;
  if v_seq is not null then
    select * into v_seqrow from servicing.schedule_snapshots s where s.loan_account_id = v_loan.id and s.lender_sequence = v_seq limit 1;
    if found then
      return private.servicing_conflict(p_lender, v_loan.id, 'schedule', 'sequence_reused', v_srid, v_seqrow.id, v_seqrow.content_sha256,
        v_seqrow.reported_as_of, p_hash, v_rep, p_canon, p_source, p_batch, p_dry);
    end if;
  end if;
  select * into v_prev from servicing.schedule_snapshots s
  where s.loan_account_id = v_loan.id and s.reported_as_of is not null order by s.reported_as_of desc, s.version desc limit 1;
  if found then
    if v_rep < v_prev.reported_as_of then
      if not p_dry then
        perform private.servicing_flag(p_lender, v_loan.id, 'older_report_ignored', null, null, null, null, null, null, p_source, p_batch, v_srid, p_hash, v_rep);
      end if;
      return jsonb_build_object('outcome', 'unchanged', 'ignored', 'older_report', 'loan_account_id', v_loan.id);
    elsif v_rep = v_prev.reported_as_of then
      return private.servicing_conflict(p_lender, v_loan.id, 'schedule', 'same_time_different_content', v_srid, v_prev.id, v_prev.content_sha256,
        v_prev.reported_as_of, p_hash, v_rep, p_canon, p_source, p_batch, p_dry);
    elsif v_seq is not null and v_prev.lender_sequence is not null and v_seq < v_prev.lender_sequence then
      if not p_dry then
        perform private.servicing_flag(p_lender, v_loan.id, 'older_sequence_ignored', null, null, null, null, null, null, p_source, p_batch, v_srid, p_hash, v_rep);
      end if;
      return jsonb_build_object('outcome', 'unchanged', 'ignored', 'older_sequence', 'loan_account_id', v_loan.id);
    end if;
  end if;
  if p_dry then
    return jsonb_build_object('outcome', case when v_prev.id is null then 'new' else 'changed' end, 'loan_account_id', v_loan.id);
  end if;
  select coalesce(max(s.version), 0) + 1 into v_version from servicing.schedule_snapshots s where s.loan_account_id = v_loan.id;
  insert into servicing.schedule_snapshots (lender_org_id, loan_account_id, version, source_reference, reported_as_of, content_sha256, source,
                                            import_batch_id, source_record_id, lender_sequence, recorded_by)
  values (p_lender, v_loan.id, v_version, null, v_rep, p_hash, p_source, p_batch, v_srid, v_seq, (select auth.uid()))
  returning * into v_snap;
  insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor, fees_minor)
  select v_snap.id, p_lender, (i ->> 'installment_seq')::integer, (i ->> 'due_date')::date, private.servicing_try_money(i ->> 'principal'),
         private.servicing_try_money(i ->> 'interest'), private.servicing_try_money(i ->> 'fees')
  from jsonb_array_elements(p_canon -> 'installments') i;
  update servicing.loan_accounts la set last_synced_at = clock_timestamp() where la.id = v_loan.id;
  return jsonb_build_object('outcome', case when v_prev.id is null then 'new' else 'changed' end, 'loan_account_id', v_loan.id, 'schedule_snapshot_id', v_snap.id);
end
$$;
revoke all on function private.servicing_apply_schedule(uuid, jsonb, text, servicing.source_system, uuid, boolean) from public;

create or replace function private.servicing_apply_one(
  p_lender uuid, p_kind text, p_canon jsonb, p_hash text, p_source servicing.source_system, p_batch uuid, p_dry boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return case p_kind
    when 'loan' then private.servicing_apply_loan(p_lender, p_canon, p_hash, p_source, p_batch, p_dry)
    when 'receipt' then private.servicing_apply_receipt(p_lender, p_canon, p_hash, p_source, p_batch, p_dry)
    when 'schedule' then private.servicing_apply_schedule(p_lender, p_canon, p_hash, p_source, p_batch, p_dry)
    else null end;
end
$$;
revoke all on function private.servicing_apply_one(uuid, text, jsonb, text, servicing.source_system, uuid, boolean) from public;

-- The system entry point (workers, a future REST puller, the mock). Idempotent on (loan, content hash) and on the lender
-- sequence. p_report: the import record of format udofin-lms-import-v1 (snake_case field names, money as decimal rupee
-- strings) plus report_type (loan, receipt or schedule), source_system (file_import, manual_import, mock_lms; finbyx and
-- lender_lms cannot be active) and optionally content_sha256 (verified against the recomputed hash).
-- Returns {outcome: new | changed | unchanged | conflict | quarantined | error, ...}. Invalid reports are NOT raised: they
-- return outcome error with error_codes and field names (never values), so a worker can park them.
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
  return v_res || jsonb_build_object('content_sha256', v_val ->> 'hash');
end
$$;
revoke all on function servicing.apply_lms_report(uuid, jsonb, uuid) from public;
grant execute on function servicing.apply_lms_report(uuid, jsonb, uuid) to service_role;
comment on function servicing.apply_lms_report(uuid, jsonb, uuid) is
  'System only (service_role). The single implementation for every source of lender reports. Needs the servicing_sync switch and an active connection of the matching kind. Idempotent on (loan, content_sha256) and on the lender sequence; an older reported_as_of or sequence is ignored and counted; a status moving backwards, a rising outstanding amount without a reported charge and parts that do not add up are stored and flagged in sync_anomalies, never corrected; a different payload for the same record at the same or an older time goes to sync_conflicts; reports that cannot be tied to an application or loan are quarantined. Creates the loan account only for a matching application with complete disbursement evidence. Imports call the same private implementation per row.';

-- Final, system-only step of the disbursement: the application moves to disbursed once the lender's report created the loan
-- account with its evidence. Needed because a lender user committing an import may take the application only as far as
-- disbursement_pending (the lifecycle table reserves the last step for the system).
create or replace function servicing.complete_disbursements(p_lender uuid default null, p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app record;
  v_n integer := 0;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'system only' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'limit must be between 1 and 1000' using errcode = '22023', hint = 'bad_request';
  end if;
  perform set_config('udofin.transition_reason', 'lms_report', true);
  for v_app in
    select a.id, a.lender_org_id
    from lending.applications a
    join servicing.loan_accounts la on la.application_id = a.id and la.lender_org_id = a.lender_org_id
    where a.status = 'disbursement_pending' and la.disbursed_at is not null and la.disbursement_reference is not null
      and (p_lender is null or a.lender_org_id = p_lender)
    order by a.updated_at
    limit p_limit
  loop
    if private.feature_enabled(v_app.lender_org_id, 'servicing_sync') then
      update lending.applications set status = 'disbursed' where id = v_app.id and status = 'disbursement_pending';
      v_n := v_n + 1;
    end if;
  end loop;
  perform set_config('udofin.transition_reason', '', true);
  return v_n;
end
$$;
revoke all on function servicing.complete_disbursements(uuid, integer) from public;
grant execute on function servicing.complete_disbursements(uuid, integer) to service_role;
comment on function servicing.complete_disbursements(uuid, integer) is
  'System only. Moves applications in disbursement_pending to disbursed when a loan account with complete disbursement evidence exists (created from a lender report). Skips lenders whose servicing_sync switch is off. Returns how many were moved.';

-- ---------------------------------------------------------------------------------------------
-- F. Connection, import pipeline, conflict handling (people, aal2, permissions, servicing_sync switch)
-- ---------------------------------------------------------------------------------------------
create or replace function private.servicing_require_user(p_lender uuid, p_permission text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not coalesce(p_lender in (select private.orgs_with_permission(p_permission)), false) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
  return v_uid;
end
$$;
revoke all on function private.servicing_require_user(uuid, text) from public;

-- A person who can work with imports of this lender at all (so a batch of another lender looks like no batch).
create or replace function private.servicing_sees_lender(p_lender uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_lender in (select private.orgs_with_permission('loan.read')
                               union select private.orgs_with_permission('servicing.manual_entry')
                               union select private.orgs_with_permission('servicing.sync.manage')), false)
$$;
revoke all on function private.servicing_sees_lender(uuid) from public;

-- Creates or updates the lender's connection. file_import and manual may be active; mock only where the session allows
-- mock providers; finbyx and generic_rest can only be recorded as blocked_unverified (no specification exists).
create or replace function servicing.set_lms_connection(
  p_lender uuid, p_kind text, p_status text, p_capabilities jsonb default '{}'::jsonb, p_staleness_minutes integer default 1440, p_secret_ref text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.servicing_require_user(p_lender, 'servicing.sync.manage');
  v_id uuid;
begin
  perform private.require_feature(p_lender, 'servicing_sync');
  if p_kind is null or p_kind not in ('file_import', 'manual', 'mock', 'finbyx', 'generic_rest')
     or p_status is null or p_status not in ('draft', 'active', 'paused', 'blocked_unverified') then
    raise exception 'unknown connection kind or status' using errcode = '22023', hint = 'bad_request';
  end if;
  if p_kind in ('finbyx', 'generic_rest') and p_status <> 'blocked_unverified' then
    raise exception 'this connection kind has no specification and can only be recorded as blocked_unverified' using errcode = '55000', hint = 'connector_unverified';
  end if;
  if p_kind not in ('finbyx', 'generic_rest') and p_status = 'blocked_unverified' then
    raise exception 'only unverified connectors can be blocked_unverified' using errcode = '55000', hint = 'bad_status';
  end if;
  if not private.servicing_capabilities_ok(coalesce(p_capabilities, '{}'::jsonb)) then
    raise exception 'capabilities must be an object of known boolean flags' using errcode = '22023', hint = 'capabilities_invalid';
  end if;
  if p_staleness_minutes is null or p_staleness_minutes not between 5 and 43200 then
    raise exception 'the staleness threshold must be 5 to 43200 minutes' using errcode = '22023', hint = 'threshold_invalid';
  end if;
  if p_secret_ref is not null and (p_kind not in ('finbyx', 'generic_rest') or p_secret_ref !~ '^[A-Za-z][A-Za-z0-9_./-]{2,99}$') then
    raise exception 'a secret reference is a secret NAME and applies only to REST connectors' using errcode = '22023', hint = 'secret_ref_invalid';
  end if;
  insert into servicing.lms_connections (lender_org_id, kind, status, provider_mode, capabilities, staleness_threshold_minutes, secret_ref, created_by, updated_by)
  values (p_lender, p_kind, p_status, case when p_kind = 'mock' then 'mock' else 'production' end, coalesce(p_capabilities, '{}'::jsonb),
          p_staleness_minutes, p_secret_ref, v_uid, v_uid)
  on conflict (lender_org_id) do update
    set kind = excluded.kind, status = excluded.status, provider_mode = excluded.provider_mode, capabilities = excluded.capabilities,
        staleness_threshold_minutes = excluded.staleness_threshold_minutes, secret_ref = excluded.secret_ref, updated_by = excluded.updated_by
  returning id into v_id;
  perform private.servicing_audit(p_lender, 'servicing.connection.set', 'lms_connection', v_id::text,
    jsonb_build_object('kind', p_kind, 'status', p_status, 'staleness_threshold_minutes', p_staleness_minutes));
  return v_id;
end
$$;

create or replace function private.servicing_batch_result(p_batch uuid, p_existing boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'batch_id', b.id, 'lender_org_id', b.lender_org_id, 'status', b.status, 'existing', p_existing, 'kind', b.kind, 'source_kind', b.source_kind,
    'row_count', b.row_count,
    'counts', jsonb_build_object('new', b.count_new, 'unchanged', b.count_unchanged, 'duplicate', b.count_duplicate, 'changed', b.count_changed,
      'conflict', b.count_conflict, 'error', b.count_error, 'quarantined', b.count_quarantined, 'ignored_older', b.count_ignored_older),
    'resubmission_of', b.resubmission_of,
    'errors', coalesce((
      select jsonb_agg(jsonb_build_object('row_no', r.row_no, 'outcome', r.outcome, 'error_codes', to_jsonb(r.error_codes), 'field_names', to_jsonb(r.field_names))
                       order by r.row_no)
      from (select r0.row_no, r0.outcome, r0.error_codes, r0.field_names from servicing.import_rows r0
            where r0.batch_id = b.id and r0.outcome in ('error', 'quarantined') order by r0.row_no limit 1000) r), '[]'::jsonb),
    'errors_truncated', (b.count_error + b.count_quarantined) > 1000,
    'applied_counts', b.applied_counts, 'failure_class', b.failure_class)
  from servicing.import_batches b where b.id = p_batch
$$;
revoke all on function private.servicing_batch_result(uuid, boolean) from public;

-- Validates the WHOLE file and stores the preview; applies nothing. p_rows: a JSON array of import records of format
-- udofin-lms-import-v1 (snake_case field names; money as decimal rupee strings; one record kind per file). Any error or
-- quarantined row makes the batch `invalid` (all or nothing): it cannot be committed, and it keeps no row values. The same
-- file (same SHA-256) returns the same batch while it is live (a rejected or failed batch releases the file). A corrected file is a new batch; pass the earlier batch as p_resubmission_of.
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
  -- The same file twice returns the same batch while that batch is live.
  select * into v_b from servicing.import_batches b
  where b.lender_org_id = p_lender and b.file_sha256 = p_file_sha256 and b.status in ('uploaded', 'previewed', 'invalid', 'committed');
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

-- Applies a previewed batch: every record in ONE transaction, or none. An invalid batch is refused (hint import_has_errors).
-- If anything fails while applying, all of it is rolled back and the batch is marked `failed` (its content discarded); the
-- failure is returned as a result, not raised, so the audit record survives the rollback.
create or replace function servicing.commit_import(p_batch uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_b servicing.import_batches;
  v_row record;
  v_res jsonb;
  v_outcome text;
  v_applied text;
  v_counts jsonb := '{}'::jsonb;
  v_state text;
  v_lender uuid;
begin
  -- Authorise before locking: a batch of another lender must neither be revealed nor be lockable by an outsider.
  select b.lender_org_id into v_lender from servicing.import_batches b where b.id = p_batch;
  if not found or not private.servicing_sees_lender(v_lender) then
    raise exception 'import batch not found' using errcode = 'P0002';
  end if;
  perform private.servicing_require_user(v_lender, 'servicing.sync.manage');
  perform private.require_feature(v_lender, 'servicing_sync');
  select * into v_b from servicing.import_batches b where b.id = p_batch for update;
  if v_b.status = 'committed' then
    return private.servicing_batch_result(p_batch, true);
  elsif v_b.status = 'invalid' then
    raise exception 'this import has errors and cannot be committed; correct the file and stage it again' using errcode = '55000', hint = 'import_has_errors';
  elsif v_b.status = 'rejected' then
    raise exception 'this import was rejected' using errcode = '55000', hint = 'batch_rejected';
  elsif v_b.status = 'failed' then
    raise exception 'this import failed; stage the file again' using errcode = '55000', hint = 'batch_failed';
  elsif v_b.status <> 'previewed' then
    raise exception 'this import has not been previewed' using errcode = '55000', hint = 'batch_not_previewed';
  end if;
  perform private.servicing_require_connection(v_b.lender_org_id, v_b.source_system);

  begin
    for v_row in
      select r.id, r.outcome, r.normalised, r.row_sha256
      from servicing.import_rows r
      where r.batch_id = p_batch
      order by (v_b.kind = 'receipt' and r.normalised ->> 'receipt_kind' = 'reversal'),
               case when v_b.kind <> 'receipt' then (r.normalised ->> 'reported_as_of')::timestamptz end, r.row_no
    loop
      if v_row.outcome = 'duplicate' then
        v_applied := 'duplicate';
      else
        v_res := private.servicing_apply_one(v_b.lender_org_id, v_b.kind, v_row.normalised, v_row.row_sha256, v_b.source_system, p_batch, false);
        v_outcome := v_res ->> 'outcome';
        if v_outcome is null or v_outcome not in ('new', 'changed', 'unchanged', 'conflict') then
          raise exception 'a record could not be applied' using errcode = 'P0001', hint = 'row_not_applicable';
        end if;
        v_applied := case when v_res ? 'ignored' then 'ignored_older' else v_outcome end;
      end if;
      update servicing.import_rows r set applied_result = v_applied, applied_at = clock_timestamp() where r.id = v_row.id;
      v_counts := jsonb_set(v_counts, array[v_applied], to_jsonb(coalesce((v_counts ->> v_applied)::integer, 0) + 1));
    end loop;
    update servicing.lms_connections c set last_success_at = clock_timestamp() where c.lender_org_id = v_b.lender_org_id;
    update servicing.import_batches b set status = 'committed', committed_by = v_uid, committed_at = clock_timestamp(), applied_counts = v_counts
    where b.id = p_batch;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    update servicing.import_batches b set status = 'failed', failure_class = v_state, failed_at = clock_timestamp(),
      reported_as_of_min = null, reported_as_of_max = null where b.id = p_batch;
    update servicing.import_rows r set normalised = null, source_record_id = null, row_sha256 = null where r.batch_id = p_batch;
    perform private.servicing_audit(v_b.lender_org_id, 'servicing.import.failed', 'import_batch', p_batch::text,
      jsonb_build_object('kind', v_b.kind, 'failure_class', v_state, 'row_count', v_b.row_count));
    return private.servicing_batch_result(p_batch, false);
  end;

  perform private.servicing_audit(v_b.lender_org_id, 'servicing.import.committed', 'import_batch', p_batch::text,
    jsonb_build_object('kind', v_b.kind, 'row_count', v_b.row_count, 'applied', v_counts, 'staged_by', v_b.uploaded_by));
  perform ops.enqueue_event('servicing.import.committed', jsonb_build_object('batch_id', p_batch, 'lender_org_id', v_b.lender_org_id), null,
                            'import-committed:' || p_batch::text);
  return private.servicing_batch_result(p_batch, false);
end
$$;

-- Discards a previewed batch. Its content is dropped (hashes, counts and codes stay).
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

-- A file the importer refused before any record reached the database (unparseable, too large, a column or a record the format
-- does not allow) leaves an audit record too, as owner decision 10 requires of every failed attempt: the file hash and size, the
-- number of records, and the POSITIONS, error classes and field names. Never a value: every element is checked against closed
-- lists and the audit metadata is rebuilt from the checked parts only. (Files that do reach servicing.stage_import are recorded
-- there as invalid batches instead.)
create or replace function servicing.record_rejected_file(
  p_lender uuid, p_kind text, p_source_kind text, p_file_sha256 text, p_byte_size bigint, p_format_version text, p_record_count integer, p_errors jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_codes constant text[] := array[
    'file_too_large', 'too_many_rows', 'empty_file', 'malformed_file', 'unknown_column', 'missing_column', 'duplicate_column', 'column_count_mismatch',
    'unknown_field', 'missing_required', 'invalid_reference', 'borrower_ref_looks_personal', 'invalid_amount', 'amount_not_positive', 'invalid_date',
    'invalid_timestamp', 'timestamp_in_future', 'invalid_integer', 'invalid_status', 'invalid_receipt_kind', 'incomplete_disbursement', 'incomplete_next_due',
    'disbursed_exceeds_sanctioned', 'reversal_reference_invalid', 'invalid_items', 'inconsistent_report_head', 'duplicate_row', 'conflicting_duplicate'];
  v_bad integer;
  v_errors jsonb;
begin
  perform private.servicing_require_user(p_lender, 'servicing.manual_entry');
  perform private.require_feature(p_lender, 'servicing_sync');
  if p_kind is null or p_kind not in ('loan', 'receipt', 'schedule') or p_source_kind is null or p_source_kind not in ('file', 'manual')
     or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' or p_byte_size is null or p_byte_size < 0 or p_byte_size > 1099511627776
     or p_record_count is null or p_record_count not between 0 and 100000000 then
    raise exception 'invalid request' using errcode = '22023', hint = 'bad_request';
  end if;
  if p_format_version is distinct from 'udofin-lms-import-v1' then
    raise exception 'unsupported import format' using errcode = '22023', hint = 'format_unsupported';
  end if;
  if p_errors is null or jsonb_typeof(p_errors) <> 'array' or jsonb_array_length(p_errors) not between 1 and 1000 then
    raise exception 'between 1 and 1000 errors are recorded' using errcode = '22023', hint = 'errors_invalid';
  end if;
  select count(*) into v_bad from jsonb_array_elements(p_errors) e
  where coalesce(jsonb_typeof(e) <> 'object', true)
     or coalesce(jsonb_typeof(e -> 'row_no') <> 'number', true) or coalesce((e ->> 'row_no') !~ '^[0-9]{1,8}$', true)
     or coalesce(jsonb_typeof(e -> 'code') <> 'string', true) or not coalesce((e ->> 'code') = any (v_codes), false)
     or not (e -> 'field' is null or jsonb_typeof(e -> 'field') = 'null'
             or (jsonb_typeof(e -> 'field') = 'string' and coalesce((e ->> 'field') = any (private.servicing_known_fields()), false)));
  if v_bad > 0 then
    raise exception 'each error needs a row number, a known error code and a known field name or null' using errcode = '22023', hint = 'errors_invalid';
  end if;
  select jsonb_agg(jsonb_build_object('row_no', (e.value ->> 'row_no')::integer, 'code', e.value ->> 'code', 'field', e.value -> 'field') order by e.ord)
    into v_errors from jsonb_array_elements(p_errors) with ordinality as e (value, ord);
  perform private.servicing_audit(p_lender, 'servicing.import.file_rejected', 'import_file', p_file_sha256,
    jsonb_build_object('kind', p_kind, 'source_kind', p_source_kind, 'format_version', p_format_version, 'file_sha256', p_file_sha256, 'byte_size', p_byte_size,
      'record_count', p_record_count, 'error_count', jsonb_array_length(v_errors), 'errors', v_errors));
  return jsonb_build_object('recorded', true, 'error_count', jsonb_array_length(v_errors));
end
$$;

-- Row-level problems of a stored preview (positions, classes and field names; never values). Runs as the caller, so row
-- level security applies (loan.read of the lender).
create or replace function servicing.import_errors(p_batch uuid)
returns table (row_no integer, outcome text, error_codes text[], field_names text[], flags text[])
language sql
stable
security invoker
set search_path = ''
as $$
  select r.row_no, r.outcome, r.error_codes, r.field_names, r.flags
  from servicing.import_rows r
  where r.batch_id = p_batch and r.outcome in ('error', 'quarantined')
  order by r.row_no
$$;

-- Conflict queue: open -> acknowledged -> resolved, by a lender user with servicing.sync.manage.
create or replace function servicing.acknowledge_sync_conflict(p_conflict uuid)
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
  if v_c.status <> 'open' then
    raise exception 'the conflict is %, not open', v_c.status using errcode = '55000', hint = 'conflict_not_open';
  end if;
  update servicing.sync_conflicts c set status = 'acknowledged', acknowledged_by = v_uid, acknowledged_at = clock_timestamp() where c.id = p_conflict;
  perform private.servicing_audit(v_c.lender_org_id, 'servicing.conflict.acknowledged', 'sync_conflict', p_conflict::text, jsonb_build_object('record_type', v_c.record_type));
end
$$;

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
  if p_evidence is null or p_evidence = '{}'::jsonb or not private.feature_evidence_ok(p_evidence) then
    raise exception 'the evidence reviewed must be a flat object of short reference strings' using errcode = '22023', hint = 'evidence_invalid';
  end if;
  -- Only the handling status changes. Neither version is rewritten, applied, hidden or deleted.
  update servicing.sync_conflicts c set status = 'resolved', resolved_by = v_uid, resolved_at = clock_timestamp(), confirmed_version = p_confirmed_version,
    resolution_note = trim(p_note), evidence_reviewed = p_evidence where c.id = p_conflict;
  perform private.servicing_audit(v_c.lender_org_id, 'servicing.conflict.resolved', 'sync_conflict', p_conflict::text,
    jsonb_build_object('record_type', v_c.record_type, 'confirmed_version', p_confirmed_version));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- G. Reads. Lenders: tables under row level security (loan.read). Borrowers: the two functions below, which return only
--    what the lender reported, never a computed figure, and nothing about anomalies, conflicts or imports.
-- ---------------------------------------------------------------------------------------------
create view servicing.loan_sync_status with (security_invoker = true) as
select la.id as loan_account_id,
       la.lender_org_id,
       la.lms_loan_ref,
       la.status as loan_status,
       b.id as newest_snapshot_id,
       b.reported_as_of as newest_reported_as_of,
       b.received_at as newest_received_at,
       b.status as newest_reported_status,
       coalesce(c.staleness_threshold_minutes, 1440) as staleness_threshold_minutes,
       -- Stale when nothing was ever reported, or the newest report is older than the lender's threshold.
       (b.reported_as_of is null or b.reported_as_of < now() - make_interval(mins => coalesce(c.staleness_threshold_minutes, 1440))) as stale,
       exists (select 1 from servicing.sync_conflicts sc where sc.loan_account_id = la.id and sc.status <> 'resolved') as has_open_conflict,
       exists (select 1 from servicing.sync_anomalies an where an.snapshot_id = b.id and an.severity = 'warning') as newest_has_warning
from servicing.loan_accounts la
left join lateral (
  select s.* from servicing.balance_snapshots s where s.loan_account_id = la.id order by s.reported_as_of desc, s.version desc limit 1
) b on true
left join servicing.lms_connections c on c.lender_org_id = la.lender_org_id
-- Lenders (and platform grantees) only: a borrower, who may read their own loan row, gets nothing from this view.
where la.lender_org_id in (select private.orgs_with_permission('loan.read'));
comment on view servicing.loan_sync_status is
  'Per loan: the newest report, whether it is stale (older than the connection''s staleness threshold, default 24 hours, or none yet), and whether open conflicts or warnings exist. Runs as the caller, so row level security applies. Staleness is now minus the newest reported_as_of, nothing else.';

create or replace function private.servicing_borrower_loans(p_loan uuid)
returns table (
  loan_account_id uuid, lender_org_id uuid, lender_display_name text, lender_loan_ref text, loan_status servicing.loan_status,
  sanctioned_amount_minor bigint, disbursed_amount_minor bigint, disbursed_at timestamptz,
  reported_status servicing.loan_status, reported_as_of timestamptz, received_at timestamptz, stale boolean, stale_threshold_minutes integer,
  figures_available boolean,
  outstanding_principal_minor bigint, overdue_principal_minor bigint, overdue_interest_minor bigint, penal_charges_minor bigint, other_charges_minor bigint,
  total_overdue_minor bigint, next_due_on date, next_due_minor bigint, days_past_due integer)
language sql
stable
security definer
set search_path = ''
as $$
  select la.id, la.lender_org_id, o.display_name, la.lms_loan_ref, la.status, la.sanctioned_amount_minor, la.disbursed_amount_minor, la.disbursed_at,
         case when f.ok then b.status end, b.reported_as_of, b.received_at,
         (b.reported_as_of is null or b.reported_as_of < now() - make_interval(mins => coalesce(c.staleness_threshold_minutes, 1440))),
         coalesce(c.staleness_threshold_minutes, 1440),
         f.ok,
         case when f.ok then b.outstanding_principal_minor end, case when f.ok then b.overdue_principal_minor end,
         case when f.ok then b.overdue_interest_minor end, case when f.ok then b.penal_charges_minor end, case when f.ok then b.other_charges_minor end,
         case when f.ok then b.total_overdue_minor end, case when f.ok then b.next_due_on end, case when f.ok then b.next_due_minor end,
         case when f.ok then b.days_past_due end
  from servicing.loan_accounts la
  join tenancy.organizations o on o.id = la.lender_org_id
  left join lateral (
    select s.* from servicing.balance_snapshots s where s.loan_account_id = la.id order by s.reported_as_of desc, s.version desc limit 1
  ) b on true
  left join servicing.lms_connections c on c.lender_org_id = la.lender_org_id
  cross join lateral (
    -- Fail closed: figures are shown only for a consistent report. A warning flag on the newest report or an unresolved
    -- conflict about the loan REPORT (record_type loan: the figures themselves are disputed) withholds them until the lender
    -- sends a correction or resolves the conflict; the borrower is not told why. Receipt and schedule conflicts concern other
    -- records and do not withhold the reported balance.
    select (b.id is not null
            and not exists (select 1 from servicing.sync_anomalies an where an.snapshot_id = b.id and an.severity = 'warning')
            and not exists (select 1 from servicing.sync_conflicts sc where sc.loan_account_id = la.id and sc.record_type = 'loan' and sc.status <> 'resolved')) as ok
  ) f
  where la.borrower_id = (select private.my_borrower_id())
    and (p_loan is null or la.id = p_loan)
    and private.feature_enabled(la.lender_org_id, 'servicing_sync')
$$;
revoke all on function private.servicing_borrower_loans(uuid) from public;

create or replace function servicing.my_loans()
returns table (
  loan_account_id uuid, lender_org_id uuid, lender_display_name text, lender_loan_ref text, loan_status servicing.loan_status,
  sanctioned_amount_minor bigint, disbursed_amount_minor bigint, disbursed_at timestamptz,
  reported_status servicing.loan_status, reported_as_of timestamptz, received_at timestamptz, stale boolean, stale_threshold_minutes integer,
  figures_available boolean,
  outstanding_principal_minor bigint, overdue_principal_minor bigint, overdue_interest_minor bigint, penal_charges_minor bigint, other_charges_minor bigint,
  total_overdue_minor bigint, next_due_on date, next_due_minor bigint, days_past_due integer)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.servicing_borrower_loans(null)
$$;

create or replace function servicing.my_loan(p_loan uuid)
returns table (
  loan_account_id uuid, lender_org_id uuid, lender_display_name text, lender_loan_ref text, loan_status servicing.loan_status,
  sanctioned_amount_minor bigint, disbursed_amount_minor bigint, disbursed_at timestamptz,
  reported_status servicing.loan_status, reported_as_of timestamptz, received_at timestamptz, stale boolean, stale_threshold_minutes integer,
  figures_available boolean,
  outstanding_principal_minor bigint, overdue_principal_minor bigint, overdue_interest_minor bigint, penal_charges_minor bigint, other_charges_minor bigint,
  total_overdue_minor bigint, next_due_on date, next_due_minor bigint, days_past_due integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_loan is null or not exists (select 1 from private.servicing_borrower_loans(p_loan)) then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  return query select * from private.servicing_borrower_loans(p_loan);
end
$$;

-- What the lender reported as of a past time: the newest report whose reported_as_of is not after p_at. Runs as the caller
-- (row level security: loan.read of the lender), so a borrower or another lender gets nothing.
create or replace function servicing.loan_as_reported_at(p_loan uuid, p_at timestamptz)
returns setof servicing.balance_snapshots
language sql
stable
security invoker
set search_path = ''
as $$
  select s.* from servicing.balance_snapshots s
  where s.loan_account_id = p_loan and s.reported_as_of <= p_at
  order by s.reported_as_of desc, s.version desc
  limit 1
$$;

-- What Udofin KNEW at a past time: the newest report (by the lender's time) among those already received by p_at. This differs
-- from loan_as_reported_at when a report reaches us late (a backfilled or delayed file).
create or replace function servicing.loan_as_known_at(p_loan uuid, p_at timestamptz)
returns setof servicing.balance_snapshots
language sql
stable
security invoker
set search_path = ''
as $$
  select s.* from servicing.balance_snapshots s
  where s.loan_account_id = p_loan and s.received_at <= p_at
  order by s.reported_as_of desc, s.version desc
  limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- H. Grants and comments
-- ---------------------------------------------------------------------------------------------
grant select on servicing.loan_sync_status to authenticated, service_role;

revoke all on function servicing.set_lms_connection(uuid, text, text, jsonb, integer, text) from public;
revoke all on function servicing.stage_import(uuid, text, text, text, bigint, text, jsonb, text, uuid) from public;
revoke all on function servicing.commit_import(uuid) from public;
revoke all on function servicing.reject_import(uuid, text) from public;
revoke all on function servicing.record_rejected_file(uuid, text, text, text, bigint, text, integer, jsonb) from public;
revoke all on function servicing.import_errors(uuid) from public;
revoke all on function servicing.acknowledge_sync_conflict(uuid) from public;
revoke all on function servicing.resolve_sync_conflict(uuid, text, text, jsonb) from public;
revoke all on function servicing.my_loans() from public;
revoke all on function servicing.my_loan(uuid) from public;
revoke all on function servicing.loan_as_reported_at(uuid, timestamptz) from public;
revoke all on function servicing.loan_as_known_at(uuid, timestamptz) from public;
grant execute on function servicing.set_lms_connection(uuid, text, text, jsonb, integer, text) to authenticated;
grant execute on function servicing.stage_import(uuid, text, text, text, bigint, text, jsonb, text, uuid) to authenticated;
grant execute on function servicing.commit_import(uuid) to authenticated;
grant execute on function servicing.reject_import(uuid, text) to authenticated;
grant execute on function servicing.record_rejected_file(uuid, text, text, text, bigint, text, integer, jsonb) to authenticated;
grant execute on function servicing.import_errors(uuid) to authenticated;
grant execute on function servicing.acknowledge_sync_conflict(uuid) to authenticated;
grant execute on function servicing.resolve_sync_conflict(uuid, text, text, jsonb) to authenticated;
grant execute on function servicing.my_loans() to authenticated;
grant execute on function servicing.my_loan(uuid) to authenticated;
grant execute on function servicing.loan_as_reported_at(uuid, timestamptz) to authenticated;
grant execute on function servicing.loan_as_known_at(uuid, timestamptz) to authenticated;

comment on function servicing.set_lms_connection(uuid, text, text, jsonb, integer, text) is
  'servicing.sync.manage of the lender, aal2, servicing_sync switch on. Creates or updates the lender''s single LMS connection. file_import and manual may be active; mock only where udofin.allow_mock_providers is on; finbyx and generic_rest only as blocked_unverified (55000 connector_unverified).';
comment on function servicing.stage_import(uuid, text, text, text, bigint, text, jsonb, text, uuid) is
  'servicing.manual_entry of the lender, aal2, servicing_sync switch on, active connection. Validates the whole file and stores the preview; applies nothing. Any error or quarantined record makes the batch invalid (all or nothing, owner decision of 14 Oct 2026) and the stored batch keeps no row values. The same file (SHA-256) returns the same batch. Returns the batch with its counts and row-level errors (row number, codes, field names).';
comment on function servicing.commit_import(uuid) is
  'servicing.sync.manage of the lender, aal2, servicing_sync switch on. Applies a previewed batch in one transaction through the same private implementation as servicing.apply_lms_report. An invalid batch is refused (55000, hint import_has_errors). On any failure everything is rolled back and the batch is recorded as failed (SQLSTATE only, no content); the failure is returned, not raised.';
comment on function servicing.reject_import(uuid, text) is
  'servicing.manual_entry or servicing.sync.manage, aal2. Discards a previewed batch with a reason; its content is dropped, hashes, counts and codes stay.';
comment on function servicing.record_rejected_file(uuid, text, text, text, bigint, text, integer, jsonb) is
  'servicing.manual_entry of the lender, aal2, servicing_sync switch on. Audit record for a file the importer refused before any record reached the database: file hash, size, record count and the positions, error classes and field names of the errors (closed lists, never values). Writes one audit.events row; creates no batch.';
comment on function servicing.my_loans() is
  'Borrower only (empty for anyone else). The caller''s loans with only what the lender reported: reported_as_of, lender display name, a stale flag and figures_available (false when there is no report yet or the newest report is under review). No figure is ever computed here. Lenders whose servicing_sync switch is off are not listed.';
comment on function servicing.my_loan(uuid) is
  'Borrower only. One of the caller''s own loans, as servicing.my_loans. Another borrower''s loan, an unknown loan and a lender whose switch is off all answer P0002.';
comment on function servicing.loan_as_reported_at(uuid, timestamptz) is
  'The newest report whose reported_as_of is not after p_at, as stored (what the lender said at that time). SECURITY INVOKER: row level security applies (loan.read).';
comment on function servicing.loan_as_known_at(uuid, timestamptz) is
  'The newest report (by the lender''s time) among those Udofin had already received by p_at: what was known then, which differs from loan_as_reported_at when a report arrived late. SECURITY INVOKER (loan.read).';
comment on function servicing.import_errors(uuid) is
  'Row-level problems of a stored preview: row number, outcome, error codes, names of the fields at fault, flags. Never values. SECURITY INVOKER (row level security, loan.read).';
