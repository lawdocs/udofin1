-- =============================================================================================
-- Phase 07, part 2b: lender KFS data intake and structural validation, document generation (jobs), lender approval,
-- issuance, withdrawal, supersession, lender-uploaded KFS and the expiry sweep.
--
-- Validation here is STRUCTURAL: it flags a figure for the lender to correct; it never alters, rounds or recomputes
-- anything the lender supplied. Where a check compares two lender-supplied figures, a difference is reported, never fixed.
-- The arithmetic cross-checks (sums, balances, row totals) are skipped only when the lender supplies its own rounding note,
-- as the RBI's illustration itself needs (its schedule differs from its totals by rounding; D-61).
-- =============================================================================================

-- A second rule for the agreement's KFS summary box (RBC para 29(6)). Draft, like the KFS rule.
insert into documents.applicability_rules (rule_key, version, lender_category_keys, regulator, direction_ref, paragraph_refs, product_category_keys,
  exclusions, document_type, required_template_key, required_fields_version, required_acknowledgements, ack_sections, validity_rule, language_policy,
  effective_from, approval_status, evidence_status)
values ('agreement.nbfc.kfs_summary_box', 1, array['nbfc_icc', 'nbfc_d'], 'RBI',
  'RBC Directions 2025 (RBI/DOR/2025-26/362), text updated as on 1 April 2026', array['29(6)'], array['personal'],
  'DRAFT FOR LEGAL/COMPLIANCE REVIEW. The agreement text itself is the lender''s approved template; Udofin supplies none. Same exclusions as the KFS rule.',
  'loan_agreement', 'agreement.loan', 'kfs_data_v1', '{}', '{}', '{}'::jsonb,
  '{"policy":"approved_template_per_language","fallback":"none"}'::jsonb, date '2025-11-28', 'draft', 'interpretation');

-- A JSON type name that is never NULL: a missing key reads as 'missing', so "is not an object" is true when the key is absent.
create or replace function private.jt(j jsonb)
returns text
language sql
immutable
set search_path = ''
as $$ select coalesce(jsonb_typeof(j), 'missing') $$;

-- ---------------------------------------------------------------------------------------------
-- Structural validation of the lender's KFS data (kfs_data_v1). Returns issue codes; empty means "structurally acceptable".
-- ---------------------------------------------------------------------------------------------
create or replace function private.valid_charge(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select private.jt(p) = 'object' and (
       (private.jint(p, 'amountMinor') >= 0)
    or (private.jint(p, 'percentBps') >= 0)
    or (private.jt(p -> 'text') = 'string' and length(p ->> 'text') between 1 and 500)
    or (p -> 'notApplicable') = 'true'::jsonb)
$$;

create or replace function private.kfs_issues(p jsonb, o lending.offers)
returns text[]
language plpgsql
stable
set search_path = ''
as $$
declare
  i text[] := '{}';
  v bigint;
  f jsonb;
  r jsonb;
  prev_day date;
  d date;
  n integer;
  sum_principal bigint := 0;
  sum_interest bigint := 0;
  prev_outstanding bigint;
  fee_lender bigint := 0;
  fee_third bigint := 0;
  fee_all_amounts boolean := true;
  rounding boolean;
  allowed text[] := array['schema', 'proposalNo', 'loanType', 'borrowerNameAsPerLender', 'sanctionedAmountMinor', 'disbursal', 'loanTerm', 'tenureDays',
    'instalments', 'interest', 'floating', 'fees', 'noFees', 'aprBps', 'contingent', 'computation', 'schedule', 'part2'];
begin
  if private.jt(p) <> 'object' or p ->> 'schema' is distinct from 'kfs_data_v1' then return array['schema_wrong']; end if;
  if exists (select 1 from jsonb_object_keys(p) k where k <> all (allowed)) then i := array_append(i, 'unknown_field'); end if;
  rounding := coalesce(private.jt(p #> '{computation,roundingNote}') = 'string' and length(p #>> '{computation,roundingNote}') between 5 and 500, false);

  if p ? 'proposalNo' and (private.jt(p -> 'proposalNo') <> 'string' or p ->> 'proposalNo' !~ '^[A-Za-z0-9._/-]{4,60}$') then i := array_append(i, 'proposal_no_invalid'); end if;
  if private.jt(p -> 'loanType') <> 'string' or length(p ->> 'loanType') not between 1 and 80 then i := array_append(i, 'loan_type_missing'); end if;

  v := private.jint(p, 'sanctionedAmountMinor');
  if v is null or v <= 0 then i := array_append(i, 'sanctioned_amount_invalid');
  elsif v <> o.principal_minor then i := array_append(i, 'amount_mismatch_offer'); end if;

  v := private.jint(p, 'tenureDays');
  if v is null or v <= 0 then i := array_append(i, 'tenure_invalid');
  elsif v <> o.tenure_days then i := array_append(i, 'tenor_mismatch_offer'); end if;
  if private.jt(p -> 'loanTerm') <> 'object' or coalesce(private.jint(p -> 'loanTerm', 'value'), 0) <= 0
     or not coalesce((p #>> '{loanTerm,unit}') = any (array['days', 'months', 'years']), false) then
    i := array_append(i, 'loan_term_invalid');
  end if;

  if private.jt(p -> 'disbursal') <> 'object' or (p #>> '{disbursal,mode}') not in ('upfront', 'staged')
     or ((p #>> '{disbursal,mode}') = 'staged' and (private.jt(p #> '{disbursal,stagedClauseRef}') <> 'string')) then
    i := array_append(i, 'disbursal_invalid');
  end if;

  if private.jt(p -> 'instalments') <> 'object' then i := array_append(i, 'instalments_missing');
  else
    if (p #>> '{instalments,type}') not in ('epi', 'non_equated') then i := array_append(i, 'instalment_type_invalid'); end if;
    v := private.jint(p -> 'instalments', 'count');
    if v is null or v <= 0 then i := array_append(i, 'instalment_count_invalid');
    elsif v <> o.installment_count then i := array_append(i, 'instalment_count_mismatch_offer'); end if;
    if (p #>> '{instalments,frequency}') is distinct from o.installment_frequency::text then i := array_append(i, 'instalment_frequency_mismatch_offer'); end if;
    if (p #>> '{instalments,type}') = 'epi' then
      v := private.jint(p -> 'instalments', 'amountMinor');
      if v is null or v <= 0 then i := array_append(i, 'instalment_amount_invalid');
      elsif v <> o.installment_amount_minor then i := array_append(i, 'instalment_amount_mismatch_offer'); end if;
    end if;
    if coalesce(private.jint(p -> 'instalments', 'commencementDaysAfterSanction'), -1) < 0 then i := array_append(i, 'repayment_commencement_missing'); end if;
  end if;

  v := private.jint(p -> 'interest', 'rateBps');
  if private.jt(p -> 'interest') <> 'object' or v is null or v < 0 or v > 10000 then i := array_append(i, 'interest_rate_invalid');
  elsif v <> o.annual_interest_rate_bps then i := array_append(i, 'rate_mismatch_offer'); end if;
  if (p #>> '{interest,type}') not in ('fixed', 'floating', 'hybrid') then i := array_append(i, 'rate_type_missing');
  elsif (p #>> '{interest,type}') in ('floating', 'hybrid') then
    f := p -> 'floating';
    if private.jt(f) <> 'object' or private.jt(f -> 'referenceBenchmark') <> 'string'
       or private.jint(f, 'benchmarkRateBps') is null or private.jint(f, 'spreadBps') is null or private.jint(f, 'finalRateBps') is null
       or coalesce(private.jint(f, 'resetPeriodicityMonths'), 0) <= 0
       or private.jt(f -> 'impactOf25bps') <> 'object'
       or private.jint(f -> 'impactOf25bps', 'epiOnBenchmarkMinor') is null or private.jint(f -> 'impactOf25bps', 'epiOnSpreadMinor') is null
       or private.jint(f -> 'impactOf25bps', 'epiCountOnBenchmark') is null or private.jint(f -> 'impactOf25bps', 'epiCountOnSpread') is null then
      i := array_append(i, 'floating_table_incomplete');
    elsif private.jint(f, 'finalRateBps') <> private.jint(f, 'benchmarkRateBps') + private.jint(f, 'spreadBps') then
      i := array_append(i, 'floating_rate_inconsistent');
    end if;
  end if;

  v := private.jint(p, 'aprBps');
  if v is null then i := array_append(i, 'apr_missing');
  elsif v <> o.apr_bps then i := array_append(i, 'apr_mismatch_offer'); end if;

  if private.jt(p -> 'fees') <> 'array' then i := array_append(i, 'fees_missing');
  else
    if jsonb_array_length(p -> 'fees') = 0 and (p -> 'noFees') is distinct from 'true'::jsonb then i := array_append(i, 'fees_missing'); end if;
    for f in select * from jsonb_array_elements(p -> 'fees') loop
      if private.jt(f) <> 'object' or (f ->> 'category') not in ('processing', 'insurance', 'valuation', 'other')
         or private.jt(f -> 'label') <> 'string' or (f ->> 'payee') not in ('lender', 'third_party')
         or (f ->> 'timing') not in ('one_time', 'recurring')
         or ((f ->> 'timing') = 'recurring' and private.jt(f -> 'frequency') <> 'string')
         or ((private.jint(f, 'amountMinor') is null) = (private.jint(f, 'percentBps') is null))
         or coalesce(private.jint(f, 'amountMinor'), private.jint(f, 'percentBps')) < 0 then
        i := array_append(i, 'fee_invalid');
      elsif private.jint(f, 'amountMinor') is null then fee_all_amounts := false;
      elsif (f ->> 'payee') = 'lender' then fee_lender := fee_lender + private.jint(f, 'amountMinor');
      else fee_third := fee_third + private.jint(f, 'amountMinor'); end if;
      if (f ->> 'category') = 'processing' and (f ->> 'payee') = 'lender' and private.jint(f, 'amountMinor') is not null
         and private.jint(f, 'amountMinor') <> o.processing_fee_minor then
        i := array_append(i, 'processing_fee_mismatch_offer');
      end if;
    end loop;
    if o.processing_fee_minor > 0 and not exists (select 1 from jsonb_array_elements(p -> 'fees') x where x ->> 'category' = 'processing') then
      i := array_append(i, 'processing_fee_missing');
    end if;
  end if;

  if private.jt(p -> 'contingent') <> 'object' then i := array_append(i, 'penal_charges_missing');
  else
    if not private.valid_charge(p #> '{contingent,penalDelayed}') then i := array_append(i, 'penal_charges_missing'); end if;
    if not (private.valid_charge(p #> '{contingent,otherPenal}') and private.valid_charge(p #> '{contingent,foreclosure}')
            and private.valid_charge(p #> '{contingent,switching}')) then
      i := array_append(i, 'contingent_charges_incomplete');
    end if;
  end if;

  if private.jt(p -> 'computation') <> 'object' then i := array_append(i, 'computation_incomplete');
  else
    if private.jint(p -> 'computation', 'totalInterestMinor') is null or private.jint(p -> 'computation', 'feesTotalMinor') is null
       or private.jint(p -> 'computation', 'feesToLenderMinor') is null or private.jint(p -> 'computation', 'feesToThirdPartyMinor') is null
       or coalesce(private.jint(p -> 'computation', 'netDisbursedMinor'), 0) <= 0 or coalesce(private.jint(p -> 'computation', 'totalPayableMinor'), 0) <= 0
       or private.jt(p #> '{computation,scheduleOfDisbursement}') <> 'string' then
      i := array_append(i, 'computation_incomplete');
    else
      if private.jint(p -> 'computation', 'feesTotalMinor') <> private.jint(p -> 'computation', 'feesToLenderMinor') + private.jint(p -> 'computation', 'feesToThirdPartyMinor') then
        i := array_append(i, 'fees_split_mismatch');
      end if;
      if private.jint(p, 'sanctionedAmountMinor') is not null
         and private.jint(p -> 'computation', 'netDisbursedMinor') <> private.jint(p, 'sanctionedAmountMinor') - private.jint(p -> 'computation', 'feesTotalMinor') then
        i := array_append(i, 'net_disbursed_mismatch');
      end if;
      if fee_all_amounts and private.jt(p -> 'fees') = 'array' and
         (fee_lender <> private.jint(p -> 'computation', 'feesToLenderMinor') or fee_third <> private.jint(p -> 'computation', 'feesToThirdPartyMinor')) then
        i := array_append(i, 'fees_total_mismatch');
      end if;
      if not rounding and private.jint(p, 'sanctionedAmountMinor') is not null
         and private.jint(p -> 'computation', 'totalPayableMinor') <> private.jint(p, 'sanctionedAmountMinor') + private.jint(p -> 'computation', 'totalInterestMinor') then
        i := array_append(i, 'total_payable_inconsistent');
      end if;
    end if;
  end if;

  if private.jt(p -> 'schedule') <> 'array' or jsonb_array_length(p -> 'schedule') = 0 or jsonb_array_length(p -> 'schedule') > 1200 then
    i := array_append(i, 'schedule_missing');
  else
    n := 0;
    for r in select * from jsonb_array_elements(p -> 'schedule') loop
      n := n + 1;
      if private.jt(r) <> 'object' or private.jint(r, 'no') is distinct from n::bigint or private.jint(r, 'outstandingPrincipalMinor') is null
         or private.jint(r, 'principalMinor') is null or private.jint(r, 'interestMinor') is null or private.jint(r, 'instalmentMinor') is null
         or private.jint(r, 'principalMinor') < 0 or private.jint(r, 'interestMinor') < 0 then
        i := array_append(i, 'schedule_sequence_invalid');
        exit;
      end if;
      begin
        if (r ->> 'dueDate') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'x'; end if;
        d := (r ->> 'dueDate')::date;
      exception when others then
        i := array_append(i, 'schedule_date_invalid');
        exit;
      end;
      if prev_day is not null and d <= prev_day then i := array_append(i, 'schedule_dates_invalid'); exit; end if;
      prev_day := d;
      if n = 1 and private.jint(p, 'sanctionedAmountMinor') is not null and private.jint(r, 'outstandingPrincipalMinor') <> private.jint(p, 'sanctionedAmountMinor') then
        i := array_append(i, 'schedule_outstanding_invalid');
      end if;
      if not rounding and prev_outstanding is not null and prev_outstanding <> private.jint(r, 'outstandingPrincipalMinor') then i := array_append(i, 'schedule_balance_broken'); end if;
      prev_outstanding := private.jint(r, 'outstandingPrincipalMinor') - private.jint(r, 'principalMinor');
      if not rounding and private.jint(r, 'principalMinor') + private.jint(r, 'interestMinor') <> private.jint(r, 'instalmentMinor') then
        i := array_append(i, 'schedule_row_inconsistent');
      end if;
      sum_principal := sum_principal + private.jint(r, 'principalMinor');
      sum_interest := sum_interest + private.jint(r, 'interestMinor');
    end loop;
    if not ('schedule_sequence_invalid' = any (i) or 'schedule_date_invalid' = any (i) or 'schedule_dates_invalid' = any (i)) then
      if not rounding and private.jint(p, 'sanctionedAmountMinor') is not null and sum_principal <> private.jint(p, 'sanctionedAmountMinor') then
        i := array_append(i, 'schedule_principal_sum_mismatch');
      end if;
      if (p #>> '{instalments,type}') = 'epi' and private.jint(p -> 'instalments', 'count') is not null and n <> private.jint(p -> 'instalments', 'count') then
        i := array_append(i, 'schedule_count_mismatch');
      end if;
      if not rounding and private.jt(p -> 'computation') = 'object' and private.jint(p -> 'computation', 'totalInterestMinor') is not null
         and sum_interest <> private.jint(p -> 'computation', 'totalInterestMinor') then
        i := array_append(i, 'schedule_interest_sum_mismatch');
      end if;
    end if;
  end if;

  if private.jt(p -> 'part2') <> 'object' then i := array_append(i, 'part2_incomplete');
  else
    if private.jt(p #> '{part2,recoveryAgentClauseRef}') <> 'string' or private.jt(p #> '{part2,grievanceClauseRef}') <> 'string' then i := array_append(i, 'part2_incomplete'); end if;
    if (p #>> '{part2,nodalOfficerPhone}') is null or (p #>> '{part2,nodalOfficerPhone}') !~ '^[0-9+() -]{5,20}$'
       or (p #>> '{part2,nodalOfficerEmail}') is null or (p #>> '{part2,nodalOfficerEmail}') !~ '^[^@\s]{1,100}@[^@\s]{1,150}$' then
      i := array_append(i, 'nodal_officer_incomplete');
    end if;
    if private.jt(p #> '{part2,transferOrSecuritisation}') <> 'boolean' then i := array_append(i, 'transfer_flag_missing'); end if;
    if coalesce(private.jint(p #> '{part2,digital}', 'coolingOffDays'), 0) < 1 then i := array_append(i, 'cooling_off_missing'); end if;
  end if;
  return (select coalesce(array_agg(x order by ord), '{}') from (select t.x, min(t.ord) as ord from unnest(i) with ordinality as t (x, ord) group by t.x) q);
end
$$;
revoke all on function private.kfs_issues(jsonb, lending.offers) from public;

-- A lender that issues its OWN KFS file declares only the facts Udofin needs to check and to bind the evidence.
create or replace function private.kfs_declared_issues(p jsonb, o lending.offers)
returns text[]
language plpgsql
stable
set search_path = ''
as $$
declare
  i text[] := '{}';
  v bigint;
  vf timestamptz;
  vu timestamptz;
begin
  if private.jt(p) <> 'object' or p ->> 'schema' is distinct from 'kfs_declared_v1' then return array['schema_wrong']; end if;
  if exists (select 1 from jsonb_object_keys(p) k where k <> all (array['schema', 'proposalNo', 'sanctionedAmountMinor', 'tenureDays', 'aprBps', 'kfsValidFrom', 'kfsValidUntil'])) then
    i := array_append(i, 'unknown_field');
  end if;
  if private.jt(p -> 'proposalNo') <> 'string' or p ->> 'proposalNo' !~ '^[A-Za-z0-9._/-]{4,60}$' then i := array_append(i, 'proposal_no_invalid'); end if;
  v := private.jint(p, 'sanctionedAmountMinor');
  if v is null or v <= 0 then i := array_append(i, 'sanctioned_amount_invalid'); elsif v <> o.principal_minor then i := array_append(i, 'amount_mismatch_offer'); end if;
  v := private.jint(p, 'tenureDays');
  if v is null or v <= 0 then i := array_append(i, 'tenure_invalid'); elsif v <> o.tenure_days then i := array_append(i, 'tenor_mismatch_offer'); end if;
  v := private.jint(p, 'aprBps');
  if v is null then i := array_append(i, 'apr_missing'); elsif v <> o.apr_bps then i := array_append(i, 'apr_mismatch_offer'); end if;
  vf := private.try_timestamptz(p ->> 'kfsValidFrom');
  vu := private.try_timestamptz(p ->> 'kfsValidUntil');
  if vf is null or vu is null or vu <= vf then i := array_append(i, 'kfs_validity_invalid'); end if;
  return i;
end
$$;
revoke all on function private.kfs_declared_issues(jsonb, lending.offers) from public;

-- ---------------------------------------------------------------------------------------------
-- Lender: submit the KFS data for an offer revision
-- ---------------------------------------------------------------------------------------------
create or replace function private.assert_lender_prepare(p_offer uuid)
returns lending.offers
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o lending.offers;
begin
  select * into o from lending.offers where id = p_offer;
  if not found or o.lender_org_id not in (select private.orgs_with_permission('application.read')) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if o.lender_org_id not in (select private.orgs_with_permission('document.prepare')) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
  return o;
end
$$;
revoke all on function private.assert_lender_prepare(uuid) from public;

create or replace function documents.submit_kfs_data(p_offer uuid, p_data jsonb, p_mode text default 'data')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o lending.offers := private.assert_lender_prepare(p_offer);
  v_issues text[];
  v_ver integer;
  v_id uuid;
  v_status text;
begin
  if p_mode not in ('data', 'declared_for_upload') then raise exception 'unknown mode' using errcode = '22023'; end if;
  if o.status <> 'issued' or o.valid_until <= now() then
    raise exception 'the offer is not current' using errcode = '55000', hint = 'offer_not_current';
  end if;
  if p_data is null or length(p_data::text) > 400000 then raise exception 'invalid data' using errcode = '22023', hint = 'kfs_data_invalid'; end if;
  v_issues := case p_mode when 'data' then private.kfs_issues(p_data, o) else private.kfs_declared_issues(p_data, o) end;
  v_status := case when cardinality(v_issues) = 0 then 'accepted' else 'held' end;
  perform pg_advisory_xact_lock(hashtextextended('kfs_inputs:' || p_offer::text, 0));
  select coalesce(max(package_version), 0) + 1 into v_ver from documents.kfs_inputs where offer_id = p_offer;
  insert into documents.kfs_inputs (lender_org_id, application_id, offer_id, package_version, mode, data, content_sha256, validation, issues, source, submitted_by)
  values (o.lender_org_id, o.application_id, p_offer, v_ver, p_mode, p_data, encode(sha256(convert_to(p_data::text, 'UTF8')), 'hex'), v_status, v_issues,
          'manual_portal', (select auth.uid()))
  returning id into v_id;
  perform lending.audit_event('documents.kfs_data.submitted', 'kfs_input', v_id::text, jsonb_build_object('validation', v_status, 'issues', cardinality(v_issues)));
  return jsonb_build_object('inputId', v_id, 'packageVersion', v_ver, 'validation', v_status, 'issues', to_jsonb(v_issues));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Preconditions for generating or registering a document; one place, used on request and again when the job runs.
-- Returns jsonb: {issue: code|null, ruleId, templateId, calendarId, minDays, stamped...}
-- ---------------------------------------------------------------------------------------------
create or replace function private.check_generation(p_offer uuid, p_type text, p_language text, p_input uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o lending.offers;
  a lending.applications;
  i documents.kfs_inputs;
  req lending.loan_requests;
  v_rule documents.applicability_rules;
  v_tpl documents.templates;
  v_cal uuid;
  v_min integer;
  v_window integer;
  v_from timestamptz := clock_timestamp();
  v_deadline timestamptz;
  v_until timestamptz;
  v_sample_ok boolean := coalesce(current_setting('udofin.allow_sample_documents', true), '') = 'on';
begin
  select * into o from lending.offers where id = p_offer;
  if not found then return jsonb_build_object('issue', 'offer_not_found'); end if;
  select * into a from lending.applications where id = o.application_id;
  select * into i from documents.kfs_inputs where id = p_input and offer_id = p_offer;
  if i.id is null then return jsonb_build_object('issue', 'kfs_input_missing'); end if;
  if i.mode <> 'data' and p_type <> 'kfs' then return jsonb_build_object('issue', 'kfs_input_missing'); end if;
  if i.validation <> 'accepted' then return jsonb_build_object('issue', 'kfs_input_held'); end if;
  if i.package_version <> (select max(x.package_version) from documents.kfs_inputs x where x.offer_id = p_offer) then
    return jsonb_build_object('issue', 'kfs_input_stale');
  end if;
  if not private.lender_is_live(o.lender_org_id) or not exists (select 1 from lending.lender_connectors c where c.lender_org_id = o.lender_org_id and c.status = 'active') then
    return jsonb_build_object('issue', 'lender_inactive');
  end if;
  if not exists (select 1 from lending.borrower_visible_product_versions v where v.version_id = a.product_version_id and v.lender_org_id = a.lender_org_id) then
    return jsonb_build_object('issue', 'product_inactive');
  end if;
  if p_type = 'kfs' then
    if o.status = 'withdrawn' then return jsonb_build_object('issue', 'offer_withdrawn'); end if;
    if o.status = 'expired' or o.valid_until <= now() then return jsonb_build_object('issue', 'offer_expired'); end if;
    if o.status <> 'issued' or a.status <> 'approved' then return jsonb_build_object('issue', 'offer_not_current'); end if;
  elsif p_type = 'loan_agreement' then
    if o.status <> 'accepted' or a.status not in ('offer_accepted', 'agreement_pending') then return jsonb_build_object('issue', 'offer_not_accepted'); end if;
  else
    return jsonb_build_object('issue', 'document_type_not_ready');
  end if;
  select * into req from lending.loan_requests where id = a.loan_request_id;
  v_rule := private.resolve_rule(o.lender_org_id, req.category_key, p_type, current_date);
  if v_rule.id is null then return jsonb_build_object('issue', 'applicability_unresolved'); end if;
  select t.* into v_tpl from documents.templates t
   where t.template_key = v_rule.required_template_key and t.language = p_language and t.document_type = p_type and t.status = 'approved'
     and (t.lender_org_id = o.lender_org_id or t.lender_org_id is null) and (not t.is_sample or v_sample_ok)
   order by (t.lender_org_id is not null) desc, t.version desc limit 1;
  if v_tpl.id is null then return jsonb_build_object('issue', 'template_not_ready'); end if;
  if p_type = 'loan_agreement' then
    if not exists (select 1 from documents.items k where k.offer_id = p_offer and k.document_type = 'kfs' and k.issuance_status = 'issued') then
      return jsonb_build_object('issue', 'kfs_not_issued');
    end if;
    return jsonb_build_object('issue', null, 'ruleId', v_rule.id, 'templateId', v_tpl.id);
  end if;
  -- KFS validity: separate from the offer's validity; needs the lender's approved working-day calendar.
  select c.id into v_cal from documents.calendars c
   where c.lender_org_id = o.lender_org_id and c.status = 'approved' and c.covered_from <= current_date and c.covered_to >= current_date
   order by c.approved_at desc limit 1;
  if v_cal is null then return jsonb_build_object('issue', 'calendar_missing'); end if;
  v_min := case when o.tenure_days >= 7 then (v_rule.validity_rule ->> 'min_days_tenor_ge_7')::integer else (v_rule.validity_rule ->> 'min_days_tenor_lt_7')::integer end;
  if v_min is null or v_min < 1 then return jsonb_build_object('issue', 'validity_rule_missing'); end if;
  v_window := coalesce((v_rule.validity_rule ->> 'issue_window_minutes')::integer, 60);
  v_deadline := v_from + make_interval(mins => v_window);
  begin
    v_until := documents.working_day_end(v_cal, v_deadline, v_min);
  exception when others then
    return jsonb_build_object('issue', 'calendar_incomplete');
  end;
  if o.valid_until < v_until then return jsonb_build_object('issue', 'offer_validity_shorter_than_kfs'); end if;
  return jsonb_build_object('issue', null, 'ruleId', v_rule.id, 'templateId', v_tpl.id, 'calendarId', v_cal, 'minDays', v_min,
                            'validFrom', v_from, 'validUntil', v_until, 'issueDeadline', v_deadline);
end
$$;
revoke all on function private.check_generation(uuid, text, text, uuid) from public;

create or replace function private.ensure_proposal(p_offer uuid, p_lender uuid, p_data jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v text;
begin
  select proposal_no into v from documents.proposals where offer_id = p_offer;
  if v is not null then return v; end if;
  if jsonb_typeof(p_data -> 'proposalNo') = 'string' then
    v := p_data ->> 'proposalNo';
    insert into documents.proposals (offer_id, lender_org_id, proposal_no, source) values (p_offer, p_lender, v, 'lender_supplied');
  else
    v := 'UDF-' || upper(replace(substr(gen_random_uuid()::text, 1, 13), '-', ''));
    insert into documents.proposals (offer_id, lender_org_id, proposal_no, source) values (p_offer, p_lender, v, 'udofin_allocated');
  end if;
  return v;
exception when unique_violation then
  select proposal_no into v from documents.proposals where offer_id = p_offer;
  if v is null then raise exception 'proposal number already in use' using errcode = '55000', hint = 'proposal_no_taken'; end if;
  return v;
end
$$;
revoke all on function private.ensure_proposal(uuid, uuid, jsonb) from public;

-- ---------------------------------------------------------------------------------------------
-- Request generation (lender). Idempotent: the same request returns the same job.
-- ---------------------------------------------------------------------------------------------
create or replace function documents.request_generation(p_offer uuid, p_language text, p_input uuid, p_type text default 'kfs')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o lending.offers := private.assert_lender_prepare(p_offer);
  v_check jsonb;
  v_job documents.generation_jobs;
begin
  if p_language not in ('en', 'hi') then raise exception 'unsupported language' using errcode = '22023'; end if;
  v_check := private.check_generation(p_offer, p_type, p_language, p_input);
  if v_check ->> 'issue' is not null then
    raise exception 'document cannot be prepared' using errcode = '55000', hint = v_check ->> 'issue';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('docgen:' || p_offer::text || p_type || p_language || p_input::text, 0));
  select * into v_job from documents.generation_jobs
   where offer_id = p_offer and document_type = p_type and language = p_language and kfs_input_id = p_input order by created_at desc, id desc limit 1;
  -- A finished job whose document is still live is returned as it is (no duplicate); a closed document may be prepared again.
  if v_job.id is not null and v_job.status = 'succeeded'
     and not exists (select 1 from documents.items d where d.id = v_job.document_id
                      and (d.approval_status <> 'rejected' and d.issuance_status in ('not_issued', 'issued'))) then
    v_job := null;
  end if;
  if v_job.id is null then
    insert into documents.generation_jobs (lender_org_id, application_id, offer_id, document_type, language, kfs_input_id, template_id, requested_by, requested_by_actor)
    values (o.lender_org_id, o.application_id, p_offer, p_type, p_language, p_input, (v_check ->> 'templateId')::uuid, (select auth.uid()), 'staff')
    returning * into v_job;
  elsif v_job.status = 'failed' then
    update documents.generation_jobs set status = 'pending', failure_class = null, updated_at = now() where id = v_job.id;
    v_job.status := 'pending';
  end if;
  if v_job.status = 'pending' then
    perform ops.enqueue_event('document.generate', jsonb_build_object('job_id', v_job.id), null, 'docgen:' || v_job.id::text || ':' || v_job.attempts::text);
  end if;
  perform lending.audit_event('documents.generation.requested', 'generation_job', v_job.id::text, jsonb_build_object('type', p_type, 'language', p_language));
  return jsonb_build_object('jobId', v_job.id, 'status', v_job.status, 'documentId', v_job.document_id);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Worker (system): begin, complete, fail. Safe to repeat.
-- ---------------------------------------------------------------------------------------------
create or replace function documents.begin_generation(p_job uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j documents.generation_jobs;
  v_check jsonb;
  o lending.offers;
  i documents.kfs_inputs;
  v_tpl documents.templates;
  v_lender tenancy.organizations;
  v_req lending.loan_requests;
  v_ver integer;
  v_proposal text;
  v_kfs documents.items;
begin
  if private.invoking_role() <> 'service_role' then raise exception 'system only' using errcode = '42501'; end if;
  select * into j from documents.generation_jobs where id = p_job for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if j.status = 'succeeded' then return jsonb_build_object('done', true, 'documentId', j.document_id); end if;
  v_check := private.check_generation(j.offer_id, j.document_type, j.language, j.kfs_input_id);
  if v_check ->> 'issue' is not null then
    update documents.generation_jobs set status = 'failed', failure_class = v_check ->> 'issue', attempts = attempts + 1, updated_at = now() where id = p_job;
    return jsonb_build_object('failed', v_check ->> 'issue');
  end if;
  select * into o from lending.offers where id = j.offer_id;
  select * into i from documents.kfs_inputs where id = j.kfs_input_id;
  select * into v_tpl from documents.templates where id = (v_check ->> 'templateId')::uuid;
  select * into v_lender from tenancy.organizations where id = j.lender_org_id;
  select r.* into v_req from lending.loan_requests r join lending.applications a on a.loan_request_id = r.id where a.id = j.application_id;
  select coalesce(max(version), 0) + 1 into v_ver from documents.items where offer_id = j.offer_id and document_type = j.document_type;
  v_proposal := private.ensure_proposal(j.offer_id, j.lender_org_id, i.data);
  update documents.generation_jobs set status = 'running', attempts = attempts + 1, updated_at = now(), template_id = v_tpl.id,
         stamped = v_check || jsonb_build_object('proposalNo', v_proposal, 'version', v_ver) where id = p_job;
  if j.document_type = 'loan_agreement' then
    select * into v_kfs from documents.items where offer_id = j.offer_id and document_type = 'kfs' and issuance_status = 'issued';
  end if;
  return jsonb_build_object(
    'jobId', p_job, 'documentType', j.document_type, 'language', j.language, 'version', v_ver, 'proposalNo', v_proposal,
    'offerId', j.offer_id, 'applicationId', j.application_id, 'lender', jsonb_build_object('id', v_lender.id, 'legalName', v_lender.legal_name, 'displayName', v_lender.display_name),
    'udofinReference', v_req.submission_reference,
    'template', jsonb_build_object('id', v_tpl.id, 'key', v_tpl.template_key, 'version', v_tpl.version, 'body', v_tpl.body),
    'data', i.data, 'contentDigest', i.content_sha256,
    'offer', jsonb_build_object('issuedAt', o.issued_at, 'validUntil', o.valid_until, 'revision', o.revision),
    'validity', case when j.document_type = 'kfs' then jsonb_build_object('from', v_check -> 'validFrom', 'until', v_check -> 'validUntil',
                                                                         'minWorkingDays', v_check -> 'minDays', 'issueDeadline', v_check -> 'issueDeadline') end,
    'kfsDocument', case when v_kfs.id is not null then jsonb_build_object('id', v_kfs.id, 'sha256', v_kfs.sha256, 'contentDigest', v_kfs.content_digest, 'proposalNo', v_kfs.proposal_no) end,
    'kfsTemplate', case when v_kfs.id is not null then (select t.body from documents.templates t where t.id = v_kfs.template_id) end);
end
$$;

create or replace function documents.complete_generation(p_job uuid, p_key text, p_sha text, p_size bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  j documents.generation_jobs;
  i documents.kfs_inputs;
  a lending.applications;
  s jsonb;
  v_prev uuid;
  v_id uuid;
begin
  if private.invoking_role() <> 'service_role' then raise exception 'system only' using errcode = '42501'; end if;
  select * into j from documents.generation_jobs where id = p_job for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if j.status = 'succeeded' then return j.document_id; end if;
  if j.status <> 'running' or j.stamped is null then raise exception 'job is not running' using errcode = '55000', hint = 'job_not_running'; end if;
  s := j.stamped;
  select * into i from documents.kfs_inputs where id = j.kfs_input_id;
  select * into a from lending.applications where id = j.application_id;
  select id into v_prev from documents.items where offer_id = j.offer_id and document_type = j.document_type order by version desc limit 1;
  insert into documents.items (document_type, version, lender_org_id, application_id, borrower_id, offer_id, kfs_input_id, template_id, rule_id, source_mode, language,
    proposal_no, storage_key, sha256, size_bytes, content_digest, kfs_valid_from, kfs_valid_until, kfs_min_working_days, kfs_calendar_id, issue_deadline,
    prepared_by, supersedes_id)
  values (j.document_type, (s ->> 'version')::integer, j.lender_org_id, j.application_id, a.borrower_id, j.offer_id, j.kfs_input_id, j.template_id,
    (s ->> 'ruleId')::uuid, 'generated', j.language, s ->> 'proposalNo', p_key, p_sha, p_size, i.content_sha256,
    nullif(s ->> 'validFrom', '')::timestamptz, nullif(s ->> 'validUntil', '')::timestamptz, nullif(s ->> 'minDays', '')::integer,
    nullif(s ->> 'calendarId', '')::uuid, nullif(s ->> 'issueDeadline', '')::timestamptz, j.requested_by, v_prev)
  returning id into v_id;
  update documents.generation_jobs set status = 'succeeded', document_id = v_id, failure_class = null, updated_at = now() where id = p_job;
  if j.document_type = 'loan_agreement' and a.status = 'offer_accepted' then
    perform set_config('udofin.transition_reason', 'agreement_prepared', true);
    update lending.applications set status = 'agreement_pending' where id = a.id;
  end if;
  perform private.doc_event(v_id, j.lender_org_id, 'generated', jsonb_build_object('version', (s ->> 'version')::integer, 'type', j.document_type), 'system');
  return v_id;
end
$$;

create or replace function documents.fail_generation(p_job uuid, p_class text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.invoking_role() <> 'service_role' then raise exception 'system only' using errcode = '42501'; end if;
  update documents.generation_jobs set status = 'failed', failure_class = left(regexp_replace(coalesce(p_class, 'unknown'), '[^a-z_]', '', 'g'), 50),
         updated_at = now() where id = p_job and status in ('pending', 'running');
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Register a KFS file the lender produced itself (alternative source mode). The API stores the bytes; the facts are declared.
-- ---------------------------------------------------------------------------------------------
create or replace function documents.register_upload(p_offer uuid, p_input uuid, p_key text, p_sha text, p_size bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  o lending.offers := private.assert_lender_prepare(p_offer);
  a lending.applications;
  i documents.kfs_inputs;
  req lending.loan_requests;
  v_rule documents.applicability_rules;
  v_cal uuid;
  v_min integer;
  v_from timestamptz;
  v_until timestamptz;
  v_prev uuid;
  v_id uuid;
  v_ver integer;
begin
  select * into i from documents.kfs_inputs where id = p_input and offer_id = p_offer;
  if i.id is null or i.mode <> 'declared_for_upload' then raise exception 'declared facts not found' using errcode = '55000', hint = 'kfs_input_missing'; end if;
  if i.validation <> 'accepted' then raise exception 'declared facts held' using errcode = '55000', hint = 'kfs_input_held'; end if;
  if i.package_version <> (select max(x.package_version) from documents.kfs_inputs x where x.offer_id = p_offer) then
    raise exception 'declared facts are not the latest' using errcode = '55000', hint = 'kfs_input_stale';
  end if;
  if o.status <> 'issued' or o.valid_until <= now() then raise exception 'the offer is not current' using errcode = '55000', hint = 'offer_not_current'; end if;
  select * into a from lending.applications where id = o.application_id;
  select * into req from lending.loan_requests where id = a.loan_request_id;
  v_rule := private.resolve_rule(o.lender_org_id, req.category_key, 'kfs', current_date);
  if v_rule.id is null then raise exception 'no approved rule applies' using errcode = '55000', hint = 'applicability_unresolved'; end if;
  select c.id into v_cal from documents.calendars c
   where c.lender_org_id = o.lender_org_id and c.status = 'approved' and c.covered_from <= current_date and c.covered_to >= current_date order by c.approved_at desc limit 1;
  if v_cal is null then raise exception 'no approved working-day calendar' using errcode = '55000', hint = 'calendar_missing'; end if;
  v_min := case when o.tenure_days >= 7 then (v_rule.validity_rule ->> 'min_days_tenor_ge_7')::integer else (v_rule.validity_rule ->> 'min_days_tenor_lt_7')::integer end;
  v_from := private.try_timestamptz(i.data ->> 'kfsValidFrom');
  v_until := private.try_timestamptz(i.data ->> 'kfsValidUntil');
  if v_until < documents.working_day_end(v_cal, v_from, v_min) then
    raise exception 'validity is below the minimum' using errcode = '55000', hint = 'validity_below_minimum';
  end if;
  if o.valid_until < v_until then raise exception 'offer validity is shorter than the KFS validity' using errcode = '55000', hint = 'offer_validity_shorter_than_kfs'; end if;
  perform pg_advisory_xact_lock(hashtextextended('docver:' || p_offer::text || ':kfs', 0));
  select coalesce(max(version), 0) + 1 into v_ver from documents.items where offer_id = p_offer and document_type = 'kfs';
  select id into v_prev from documents.items where offer_id = p_offer and document_type = 'kfs' order by version desc limit 1;
  perform private.ensure_proposal(p_offer, o.lender_org_id, i.data);
  insert into documents.items (document_type, version, lender_org_id, application_id, borrower_id, offer_id, kfs_input_id, rule_id, source_mode, language, proposal_no,
    storage_key, sha256, size_bytes, content_digest, generated_by, kfs_valid_from, kfs_valid_until, kfs_min_working_days, kfs_calendar_id, prepared_by, supersedes_id)
  values ('kfs', v_ver, o.lender_org_id, o.application_id, a.borrower_id, p_offer, p_input, v_rule.id, 'lender_uploaded', 'en', i.data ->> 'proposalNo',
    p_key, p_sha, p_size, i.content_sha256, 'lender_upload', v_from, v_until, v_min, v_cal, (select auth.uid()), v_prev)
  returning id into v_id;
  perform private.doc_event(v_id, o.lender_org_id, 'uploaded_by_lender', jsonb_build_object('version', v_ver));
  perform lending.audit_event('documents.kfs.uploaded', 'document', v_id::text);
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Lender: approve / reject / issue / withdraw. Nothing is issued without explicit lender approval of the exact file.
-- ---------------------------------------------------------------------------------------------
create or replace function private.assert_lender_document(p_doc uuid, p_write boolean)
returns documents.items
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d documents.items;
begin
  select * into d from documents.items where id = p_doc;
  if not found or d.lender_org_id not in (select private.orgs_with_permission('application.read')) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_write then
    if d.lender_org_id not in (select private.orgs_with_permission('document.approve')) then
      raise exception 'not authorised' using errcode = '42501';
    end if;
    perform private.require_aal2();
  end if;
  return d;
end
$$;
revoke all on function private.assert_lender_document(uuid, boolean) from public;

create or replace function documents.approve_document(p_doc uuid, p_sha256 text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d documents.items := private.assert_lender_document(p_doc, true);
begin
  select * into d from documents.items where id = p_doc for update;
  if d.approval_status <> 'draft' or d.issuance_status <> 'not_issued' then
    raise exception 'document already decided' using errcode = '55000', hint = 'already_decided';
  end if;
  if p_sha256 is distinct from d.sha256 then
    raise exception 'the file you reviewed is not the current file' using errcode = '55000', hint = 'hash_mismatch';
  end if;
  if d.prepared_by is not null and d.prepared_by = (select auth.uid())
     and not coalesce((select c.document_self_approval from lending.lender_connectors c where c.lender_org_id = d.lender_org_id), false) then
    raise exception 'a different person must approve' using errcode = '42501', hint = 'segregation_of_duties';
  end if;
  update documents.items set approval_status = 'lender_approved', approved_by = (select auth.uid()), approved_at = now(), approved_sha256 = p_sha256 where id = p_doc;
  perform private.doc_event(p_doc, d.lender_org_id, 'lender_approved', jsonb_build_object('sha256', p_sha256));
  perform lending.audit_event('documents.approved', 'document', p_doc::text);
end
$$;

create or replace function documents.reject_document(p_doc uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d documents.items := private.assert_lender_document(p_doc, true);
begin
  select * into d from documents.items where id = p_doc for update;
  if d.approval_status <> 'draft' or d.issuance_status <> 'not_issued' then
    raise exception 'document already decided' using errcode = '55000', hint = 'already_decided';
  end if;
  update documents.items set approval_status = 'rejected' where id = p_doc;
  perform private.doc_event(p_doc, d.lender_org_id, 'lender_rejected', jsonb_build_object('reason', case when p_reason ~ '^[a-z_]{2,50}$' then p_reason else 'unspecified' end));
  perform lending.audit_event('documents.rejected', 'document', p_doc::text);
end
$$;

create or replace function documents.issue_document(p_doc uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d documents.items := private.assert_lender_document(p_doc, true);
  o lending.offers;
  a lending.applications;
  v_floor timestamptz;
  v_prev uuid;
begin
  select * into d from documents.items where id = p_doc for update;
  if d.issuance_status <> 'not_issued' then raise exception 'document already issued or closed' using errcode = '55000', hint = 'already_decided'; end if;
  if d.approval_status <> 'lender_approved' or d.approved_sha256 is distinct from d.sha256 then
    raise exception 'lender approval is required' using errcode = '55000', hint = 'approval_required';
  end if;
  select * into o from lending.offers where id = d.offer_id for update;
  select * into a from lending.applications where id = d.application_id;
  if d.document_type = 'kfs' then
    if o.status = 'withdrawn' then raise exception 'the offer was withdrawn' using errcode = '55000', hint = 'offer_withdrawn'; end if;
    if o.status <> 'issued' or o.valid_until <= now() or a.status <> 'approved' then raise exception 'the offer is not current' using errcode = '55000', hint = 'offer_not_current'; end if;
    -- The window printed in the KFS must still cover the minimum counted from the moment it is made available.
    v_floor := documents.working_day_end(d.kfs_calendar_id, now(), d.kfs_min_working_days);
    if d.kfs_valid_until < v_floor then raise exception 'the prepared document is out of date; prepare it again' using errcode = '55000', hint = 'draft_stale'; end if;
    if o.valid_until < d.kfs_valid_until then raise exception 'offer validity is shorter than the KFS validity' using errcode = '55000', hint = 'offer_validity_shorter_than_kfs'; end if;
    if exists (select 1 from documents.items x where x.offer_id = d.offer_id and x.document_type = 'kfs' and x.version > d.version and x.approval_status <> 'rejected') then
      raise exception 'a newer version exists' using errcode = '55000', hint = 'newer_version_exists';
    end if;
  elsif d.document_type = 'loan_agreement' then
    if a.status <> 'agreement_pending' or o.status <> 'accepted' then raise exception 'the agreement cannot be issued now' using errcode = '55000', hint = 'offer_not_accepted'; end if;
    if not exists (select 1 from documents.items k where k.offer_id = d.offer_id and k.document_type = 'kfs' and k.content_digest = d.content_digest
                    and k.issuance_status = 'issued') then
      raise exception 'the summary box does not match the accepted KFS' using errcode = '55000', hint = 'summary_box_mismatch';
    end if;
  end if;
  select id into v_prev from documents.items where offer_id = d.offer_id and document_type = d.document_type and issuance_status = 'issued';
  if v_prev is not null then
    update documents.items set issuance_status = 'superseded', superseded_by_id = p_doc where id = v_prev;
    perform private.doc_event(v_prev, d.lender_org_id, 'superseded', jsonb_build_object('by', p_doc));
  end if;
  update documents.items set issuance_status = 'issued', issued_at = now(), issued_by = (select auth.uid()) where id = p_doc;
  insert into documents.deliveries (document_id, borrower_id, lender_org_id, channel, status) values (p_doc, d.borrower_id, d.lender_org_id, 'in_app', 'available_in_app');
  perform private.doc_event(p_doc, d.lender_org_id, 'issued', '{}'::jsonb);
  perform lending.audit_event('documents.issued', 'document', p_doc::text, jsonb_build_object('type', d.document_type, 'version', d.version));
  return jsonb_build_object('documentId', p_doc, 'issuedAt', now(), 'validUntil', d.kfs_valid_until);
end
$$;

create or replace function documents.withdraw_document(p_doc uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d documents.items := private.assert_lender_document(p_doc, true);
begin
  select * into d from documents.items where id = p_doc for update;
  if d.issuance_status not in ('not_issued', 'issued') then raise exception 'document already closed' using errcode = '55000', hint = 'already_decided'; end if;
  if exists (select 1 from documents.acceptances x where x.offer_id = d.offer_id) then
    raise exception 'an accepted offer''s documents cannot be withdrawn here' using errcode = '55000', hint = 'accepted_cannot_withdraw';
  end if;
  update documents.items set issuance_status = 'withdrawn' where id = p_doc;
  perform private.doc_event(p_doc, d.lender_org_id, 'withdrawn', jsonb_build_object('reason', case when p_reason ~ '^[a-z_]{2,50}$' then p_reason else 'unspecified' end));
  perform lending.audit_event('documents.withdrawn', 'document', p_doc::text);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Expiry sweep (system). Closing a document never deletes it.
-- ---------------------------------------------------------------------------------------------
create or replace function documents.process_expiry()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d record;
  v_exp integer := 0;
  v_wd integer := 0;
  v_jobs integer;
begin
  if private.invoking_role() <> 'service_role' then raise exception 'system only' using errcode = '42501'; end if;
  for d in select i.id, i.lender_org_id, i.issuance_status, o.status as offer_status, a.status as app_status,
                  (i.kfs_valid_until is not null and i.kfs_valid_until < now()) as kfs_over
             from documents.items i join lending.offers o on o.id = i.offer_id join lending.applications a on a.id = i.application_id
            where i.issuance_status in ('not_issued', 'issued') and i.document_type = 'kfs'
              and not exists (select 1 from documents.acceptances x where x.offer_id = i.offer_id)
            for update of i skip locked loop
    if d.offer_status = 'withdrawn' or d.app_status in ('withdrawn', 'cancelled', 'rejected') then
      update documents.items set issuance_status = 'withdrawn' where id = d.id;
      perform private.doc_event(d.id, d.lender_org_id, 'withdrawn', '{"reason":"offer_or_application_closed"}'::jsonb, 'system');
      v_wd := v_wd + 1;
    elsif d.offer_status = 'expired' or d.kfs_over then
      update documents.items set issuance_status = 'expired' where id = d.id;
      perform private.doc_event(d.id, d.lender_org_id, 'expired', jsonb_build_object('by', case when d.kfs_over then 'kfs_validity' else 'offer_validity' end), 'system');
      v_exp := v_exp + 1;
    end if;
  end loop;
  update documents.generation_jobs set status = 'failed', failure_class = 'worker_interrupted', updated_at = now()
   where status = 'running' and updated_at < now() - interval '10 minutes';
  get diagnostics v_jobs = row_count;
  return jsonb_build_object('expired', v_exp, 'withdrawn', v_wd, 'jobsInterrupted', v_jobs);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'documents.propose_rule(jsonb)', 'documents.decide_rule(uuid, boolean, text)',
    'documents.propose_template(text, text, text, uuid, jsonb, boolean)', 'documents.approve_template_compliance(uuid, text)', 'documents.approve_template_lender(uuid)',
    'documents.propose_calendar(uuid, text, integer[], date, date, jsonb)', 'documents.decide_calendar(uuid, boolean, text)', 'documents.set_self_approval(uuid, boolean)',
    'documents.submit_kfs_data(uuid, jsonb, text)', 'documents.request_generation(uuid, text, uuid, text)', 'documents.register_upload(uuid, uuid, text, text, bigint)',
    'documents.approve_document(uuid, text)', 'documents.reject_document(uuid, text)', 'documents.issue_document(uuid)', 'documents.withdraw_document(uuid, text)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['documents.begin_generation(uuid)', 'documents.complete_generation(uuid, text, text, bigint)', 'documents.fail_generation(uuid, text)',
                           'documents.process_expiry()']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;
