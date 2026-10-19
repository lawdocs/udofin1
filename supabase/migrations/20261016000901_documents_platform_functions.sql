-- =============================================================================================
-- Phase 07, part 2a: helpers, platform configuration (rules, templates, calendars) and the seeded DRAFT rule.
-- Every write goes through a function. Functions read the caller from the token claim, never from input.
-- =============================================================================================

alter table lending.lender_connectors
  add column document_self_approval boolean not null default false;
comment on column lending.lender_connectors.document_self_approval is
  'When false (default), the person who prepared a document cannot approve it (D-57: explicit lender approval required, no automatic issuance).';

alter table documents.generation_jobs add column stamped jsonb;

create or replace function private.doc_event(p_doc uuid, p_lender uuid, p_event text, p_detail jsonb, p_actor text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into documents.item_events (document_id, lender_org_id, event, detail, actor)
  values (p_doc, p_lender, p_event, coalesce(p_detail, '{}'::jsonb), p_actor)
$$;
revoke all on function private.doc_event(uuid, uuid, text, jsonb, text) from public;

-- 'lender' actors are recorded as 'staff' in the documents history (staff of the lender).
create or replace function private.doc_event(p_doc uuid, p_lender uuid, p_event text, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.doc_event(p_doc, p_lender, p_event, p_detail,
    case private.current_actor() when 'borrower' then 'borrower' when 'system' then 'system' else 'staff' end)
$$;
revoke all on function private.doc_event(uuid, uuid, text, jsonb) from public;

create or replace function private.assert_platform_documents()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_platform_permission('platform.documents.manage') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
end
$$;
revoke all on function private.assert_platform_documents() from public;

-- ---------------------------------------------------------------------------------------------
-- Working days. Validity is counted in the lender's approved calendar; without one it cannot be computed.
-- ---------------------------------------------------------------------------------------------
-- The end (23:59:59 India time) of the Nth working day AFTER the day containing p_from. The day of issue is not counted,
-- which can only make the window longer, never shorter. Interpretation of "working day" is open (D-52, D-53).
create or replace function documents.working_day_end(p_calendar uuid, p_from timestamptz, p_days integer)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cal documents.calendars;
  v_day date := (p_from at time zone 'Asia/Kolkata')::date;
  v_n integer := 0;
  v_working boolean;
begin
  if p_days is null or p_days < 1 or p_days > 60 then raise exception 'invalid number of days' using errcode = '22023'; end if;
  select * into v_cal from documents.calendars where id = p_calendar;
  if not found or v_cal.status <> 'approved' then
    raise exception 'no approved working-day calendar' using errcode = '55000', hint = 'calendar_missing';
  end if;
  if v_day < v_cal.covered_from then
    raise exception 'calendar does not cover this date' using errcode = '55000', hint = 'calendar_incomplete';
  end if;
  while v_n < p_days loop
    v_day := v_day + 1;
    if v_day > v_cal.covered_to then
      raise exception 'calendar does not cover this date' using errcode = '55000', hint = 'calendar_incomplete';
    end if;
    select coalesce((select e.is_working from documents.calendar_exceptions e where e.calendar_id = p_calendar and e.day = v_day),
                    not (extract(dow from v_day)::integer = any (v_cal.weekly_off))) into v_working;
    if v_working then v_n := v_n + 1; end if;
  end loop;
  return ((v_day::text || ' 23:59:59')::timestamp) at time zone 'Asia/Kolkata';
end
$$;
revoke all on function documents.working_day_end(uuid, timestamptz, integer) from public;
grant execute on function documents.working_day_end(uuid, timestamptz, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Applicability: exactly one approved rule, or nothing (never a fallback to another lender category's rule)
-- ---------------------------------------------------------------------------------------------
create or replace function private.resolve_rule(p_lender uuid, p_product_category text, p_document_type text, p_on date)
returns documents.applicability_rules
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cat text;
  v_rules documents.applicability_rules[];
  v documents.applicability_rules;
begin
  select lp.category_key into v_cat from onboarding.lender_profiles lp where lp.lender_org_id = p_lender;
  if v_cat is null then return null; end if;
  select array_agg(r order by r.version desc) into v_rules from documents.applicability_rules r
   where r.approval_status = 'approved' and r.document_type = p_document_type
     and v_cat = any (r.lender_category_keys) and p_product_category = any (r.product_category_keys)
     and r.effective_from <= p_on and (r.effective_to is null or r.effective_to >= p_on);
  if v_rules is null then return null; end if;
  if (select count(distinct x.rule_key) from unnest(v_rules) x) > 1 then
    raise exception 'more than one approved rule applies' using errcode = '55000', hint = 'applicability_ambiguous';
  end if;
  v := v_rules[1];
  return v;
end
$$;
revoke all on function private.resolve_rule(uuid, text, text, date) from public;

-- ---------------------------------------------------------------------------------------------
-- Platform: applicability rules (two-person; reviewer supplied by the approver, never invented)
-- ---------------------------------------------------------------------------------------------
create or replace function documents.propose_rule(p_rule jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_key text := p_rule ->> 'ruleKey';
begin
  perform private.assert_platform_documents();
  insert into documents.applicability_rules (rule_key, version, lender_category_keys, regulator, direction_ref, paragraph_refs, product_category_keys,
    exclusions, document_type, required_template_key, required_fields_version, required_acknowledgements, ack_sections, validity_rule, language_policy,
    effective_from, effective_to, approval_status, evidence_status, proposed_by)
  values (v_key,
    (select coalesce(max(version), 0) + 1 from documents.applicability_rules where rule_key = v_key),
    array(select jsonb_array_elements_text(p_rule -> 'lenderCategoryKeys')),
    p_rule ->> 'regulator', p_rule ->> 'directionRef',
    coalesce(array(select jsonb_array_elements_text(p_rule -> 'paragraphRefs')), '{}'),
    array(select jsonb_array_elements_text(p_rule -> 'productCategoryKeys')),
    p_rule ->> 'exclusions', p_rule ->> 'documentType', p_rule ->> 'requiredTemplateKey', p_rule ->> 'requiredFieldsVersion',
    coalesce(array(select jsonb_array_elements_text(p_rule -> 'requiredAcknowledgements')), '{}'),
    coalesce(array(select jsonb_array_elements_text(p_rule -> 'ackSections')), '{}'),
    coalesce(p_rule -> 'validityRule', '{}'::jsonb), coalesce(p_rule -> 'languagePolicy', '{}'::jsonb),
    (p_rule ->> 'effectiveFrom')::date, nullif(p_rule ->> 'effectiveTo', '')::date,
    'in_review', coalesce(p_rule ->> 'evidenceStatus', 'unverified'), (select auth.uid()))
  returning id into v_id;
  perform lending.audit_event('documents.rule.proposed', 'applicability_rule', v_id::text);
  return v_id;
end
$$;

create or replace function documents.decide_rule(p_id uuid, p_approve boolean, p_reviewer_ref text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v documents.applicability_rules;
begin
  perform private.assert_platform_documents();
  select * into v from documents.applicability_rules where id = p_id for update;
  if not found then raise exception 'rule not found' using errcode = 'P0002'; end if;
  if v.approval_status not in ('draft', 'in_review') then
    raise exception 'rule already decided' using errcode = '55000', hint = 'already_decided';
  end if;
  if v.proposed_by is not null and v.proposed_by = (select auth.uid()) then
    raise exception 'a different person must decide' using errcode = '42501', hint = 'segregation_of_duties';
  end if;
  if p_approve and (p_reviewer_ref is null or length(trim(p_reviewer_ref)) < 2) then
    raise exception 'the reviewer must be named' using errcode = '22023', hint = 'reviewer_required';
  end if;
  if p_approve then
    update documents.applicability_rules set approval_status = 'approved', reviewer_ref = trim(p_reviewer_ref), reviewed_on = current_date,
      approved_by = (select auth.uid()), approved_at = now() where id = p_id;
  else
    update documents.applicability_rules set approval_status = 'rejected', reviewer_ref = nullif(trim(p_reviewer_ref), ''), reviewed_on = current_date where id = p_id;
  end if;
  perform lending.audit_event('documents.rule.decided', 'applicability_rule', p_id::text, jsonb_build_object('approved', p_approve));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Platform and lender: templates
-- ---------------------------------------------------------------------------------------------
create or replace function documents.propose_template(p_key text, p_type text, p_language text, p_lender uuid, p_body jsonb, p_sample boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_lender is null then
    perform private.assert_platform_documents();
  elsif p_lender in (select private.orgs_with_permission('document.prepare')) then
    perform private.require_aal2();
  elsif private.has_platform_permission('platform.documents.manage') then
    perform private.require_aal2();
  else
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_body ->> 'engine' not in ('annex_i_v1', 'agreement_v1') then
    raise exception 'unknown template engine' using errcode = '22023', hint = 'template_engine_unknown';
  end if;
  insert into documents.templates (template_key, document_type, language, lender_org_id, version, body, is_sample, status, created_by)
  values (p_key, p_type, p_language, p_lender,
          (select coalesce(max(version), 0) + 1 from documents.templates t
            where t.template_key = p_key and t.language = p_language and t.lender_org_id is not distinct from p_lender),
          p_body, coalesce(p_sample, false), 'in_review', (select auth.uid()))
  returning id into v_id;
  perform lending.audit_event('documents.template.proposed', 'template', v_id::text);
  return v_id;
end
$$;

-- Compliance (platform) approval of a template's content; the reviewer is named by the approver.
create or replace function documents.approve_template_compliance(p_id uuid, p_reviewer_ref text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v documents.templates;
begin
  perform private.assert_platform_documents();
  select * into v from documents.templates where id = p_id for update;
  if not found then raise exception 'template not found' using errcode = 'P0002'; end if;
  if v.status not in ('draft', 'in_review') then raise exception 'template already decided' using errcode = '55000', hint = 'already_decided'; end if;
  if v.created_by is not null and v.created_by = (select auth.uid()) then
    raise exception 'a different person must approve' using errcode = '42501', hint = 'segregation_of_duties';
  end if;
  if p_reviewer_ref is null or length(trim(p_reviewer_ref)) < 2 then
    raise exception 'the reviewer must be named' using errcode = '22023', hint = 'reviewer_required';
  end if;
  update documents.templates set compliance_approved_by = (select auth.uid()), compliance_approved_at = now(), compliance_reviewer_ref = trim(p_reviewer_ref),
    status = case when lender_org_id is null or lender_approved_at is not null then 'approved' else status end where id = p_id;
  perform lending.audit_event('documents.template.compliance_approved', 'template', p_id::text);
end
$$;

-- The lender's approval of the wording that carries its name (not the same person who proposed it).
create or replace function documents.approve_template_lender(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v documents.templates;
begin
  select * into v from documents.templates where id = p_id for update;
  if not found or v.lender_org_id is null or v.lender_org_id not in (select private.orgs_with_permission('application.read')) then
    raise exception 'template not found' using errcode = 'P0002';
  end if;
  if v.lender_org_id not in (select private.orgs_with_permission('document.approve')) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
  if v.status not in ('draft', 'in_review') then raise exception 'template already decided' using errcode = '55000', hint = 'already_decided'; end if;
  if v.created_by is not null and v.created_by = (select auth.uid()) and not coalesce(
       (select c.document_self_approval from lending.lender_connectors c where c.lender_org_id = v.lender_org_id), false) then
    raise exception 'a different person must approve' using errcode = '42501', hint = 'segregation_of_duties';
  end if;
  update documents.templates set lender_approved_by = (select auth.uid()), lender_approved_at = now(),
    status = case when compliance_approved_at is not null then 'approved' else status end where id = p_id;
  perform lending.audit_event('documents.template.lender_approved', 'template', p_id::text);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Platform: working-day calendars
-- ---------------------------------------------------------------------------------------------
create or replace function documents.propose_calendar(p_lender uuid, p_name text, p_weekly_off integer[], p_from date, p_to date, p_exceptions jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  e jsonb;
begin
  perform private.assert_platform_documents();
  if not exists (select 1 from tenancy.organizations o where o.id = p_lender and o.kind = 'lender') then
    raise exception 'lender not found' using errcode = 'P0002';
  end if;
  insert into documents.calendars (lender_org_id, name, weekly_off, covered_from, covered_to, proposed_by)
  values (p_lender, p_name, coalesce(p_weekly_off, '{}'), p_from, p_to, (select auth.uid()))
  returning id into v_id;
  for e in select * from jsonb_array_elements(coalesce(p_exceptions, '[]'::jsonb)) loop
    insert into documents.calendar_exceptions (calendar_id, day, is_working, reason)
    values (v_id, (e ->> 'day')::date, (e ->> 'isWorking')::boolean, left(e ->> 'reason', 200));
  end loop;
  perform lending.audit_event('documents.calendar.proposed', 'calendar', v_id::text);
  return v_id;
end
$$;

create or replace function documents.decide_calendar(p_id uuid, p_approve boolean, p_lender_confirmation_ref text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v documents.calendars;
begin
  perform private.assert_platform_documents();
  select * into v from documents.calendars where id = p_id for update;
  if not found then raise exception 'calendar not found' using errcode = 'P0002'; end if;
  if v.status <> 'draft' then raise exception 'calendar already decided' using errcode = '55000', hint = 'already_decided'; end if;
  if v.proposed_by is not null and v.proposed_by = (select auth.uid()) then
    raise exception 'a different person must decide' using errcode = '42501', hint = 'segregation_of_duties';
  end if;
  if p_approve then
    if p_lender_confirmation_ref is null or length(trim(p_lender_confirmation_ref)) < 3 then
      raise exception 'the lender''s confirmation reference is required' using errcode = '22023', hint = 'lender_confirmation_required';
    end if;
    update documents.calendars set status = 'approved', approved_by = (select auth.uid()), approved_at = now(),
      lender_confirmation_ref = trim(p_lender_confirmation_ref) where id = p_id;
  else
    update documents.calendars set status = 'retired' where id = p_id;
  end if;
  perform lending.audit_event('documents.calendar.decided', 'calendar', p_id::text, jsonb_build_object('approved', p_approve));
end
$$;

-- Platform staff set whether the preparer may also approve (default no).
create or replace function documents.set_self_approval(p_lender uuid, p_allowed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_documents();
  update lending.lender_connectors set document_self_approval = coalesce(p_allowed, false), updated_by = (select auth.uid()), updated_at = now()
   where lender_org_id = p_lender;
  if not found then raise exception 'connector not found' using errcode = 'P0002'; end if;
  perform lending.audit_event('documents.self_approval.set', 'lender', p_lender::text, jsonb_build_object('allowed', coalesce(p_allowed, false)));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Seed: ONE draft NBFC rule and the regulator-format layout (Annex I), both for legal/compliance review only.
-- Nothing is seeded for banks, UCBs, HFCs, microfinance or any other category (D-56). Reviewer is unassigned.
-- ---------------------------------------------------------------------------------------------
insert into documents.applicability_rules (rule_key, version, lender_category_keys, regulator, direction_ref, paragraph_refs, product_category_keys,
  exclusions, document_type, required_template_key, required_fields_version, required_acknowledgements, ack_sections, validity_rule, language_policy,
  effective_from, approval_status, evidence_status)
values ('kfs.nbfc.retail_msme_term', 1, array['nbfc_icc', 'nbfc_d'], 'RBI',
  'RBC Directions 2025 (RBI/DOR/2025-26/362, DOR.MCS.REC.No.281/01-01-039/2025-26), text updated as on 1 April 2026',
  array['29(1)', '29(2)', '29(3)', '29(4)', '29(5)', '29(6)', '30', '34(8)', 'Annex I'],
  array['personal'],
  'DRAFT FOR LEGAL/COMPLIANCE REVIEW. Not covered here: NBFC-P2P (para 4), credit card receivables, microfinance, gold-loan products, HFC-specific variants, other product categories, and banks/UCBs (their own directions are not on file). Later amendments after 1 April 2026 are not on file.',
  'kfs', 'kfs.rbi_annex_i', 'kfs_data_v1', array['kfs_explained_and_understood'],
  array['part1', 'apr_sheet', 'schedule', 'part2'],
  '{"kind":"working_days","min_days_tenor_ge_7":3,"min_days_tenor_lt_7":1,"calendar_required":true,"clock":"issue_deadline_v1"}'::jsonb,
  '{"policy":"approved_template_per_language","fallback":"none"}'::jsonb,
  date '2025-11-28', 'draft', 'interpretation');

insert into documents.templates (template_key, document_type, language, lender_org_id, version, body, status)
values ('kfs.rbi_annex_i', 'kfs', 'en', null, 1,
  jsonb_build_object('engine', 'annex_i_v1', 'status_note', 'Regulator-prescribed layout (RBC Directions 2025, Annex I). DRAFT for compliance review.',
    'labels', jsonb_build_object(
      'title', 'Key Facts Statement',
      'subtitle', 'Retail and MSME term loan',
      'part1', 'Part 1 (Interest rate and fees/charges)',
      'part2', 'Part 2 (Other qualitative information)',
      'p1_1', 'Loan proposal / account no.',
      'p1_1b', 'Type of loan',
      'p1_2', 'Sanctioned loan amount (in Rupees)',
      'p1_3', 'Disbursal schedule',
      'p1_4', 'Loan term',
      'p1_5', 'Instalment details',
      'p1_5_type', 'Type of instalments',
      'p1_5_count', 'Number of EPIs',
      'p1_5_amount', 'EPI (Rs.)',
      'p1_5_commence', 'Commencement of repayment, post sanction',
      'p1_6', 'Interest rate (%) and type (fixed, floating or hybrid)',
      'p1_7', 'Additional information in case of floating rate of interest',
      'p1_7_ref', 'Reference benchmark',
      'p1_7_b', 'Benchmark rate (B) (%)',
      'p1_7_s', 'Spread (S) (%)',
      'p1_7_r', 'Final rate (%) R = (B) + (S)',
      'p1_7_reset', 'Reset periodicity (months)',
      'p1_7_impact', 'Impact of change in the reference benchmark (for 25 bps change in R, change in:)',
      'p1_8', 'Fees / charges'),
    'labels2', jsonb_build_object(
      'p1_8_a', 'Payable to the NBFC (A)',
      'p1_8_b', 'Payable to a third party through the NBFC (B)',
      'p1_9', 'Annual Percentage Rate (APR) (%)',
      'p1_10', 'Details of contingent charges (in Rs. or %, as applicable)',
      'p1_10_i', 'Penal charges, if any, in case of delayed payment',
      'p1_10_ii', 'Other penal charges, if any',
      'p1_10_iii', 'Foreclosure charges, if applicable',
      'p1_10_iv', 'Charges for switching of loans from floating to fixed rate and vice versa',
      'p1_10_v', 'Any other charges',
      'sheet', 'Computation sheet of annual percentage rate (APR)',
      'sheet_interest', 'Total interest amount to be charged during the entire tenor of the loan as per the rate prevailing on sanction date (in Rupees)',
      'sheet_fees', 'Fee / charges payable (in Rupees)',
      'sheet_net', 'Net disbursed amount (in Rupees)',
      'sheet_total', 'Total amount to be paid by the borrower (in Rupees)',
      'sheet_disbursal', 'Schedule of disbursement as per terms and conditions',
      'schedule', 'Repayment schedule',
      'sch_no', 'Instalment no.',
      'sch_date', 'Due date',
      'sch_outstanding', 'Outstanding principal (in Rupees)',
      'sch_principal', 'Principal (in Rupees)',
      'sch_interest', 'Interest (in Rupees)',
      'sch_instalment', 'Instalment (in Rupees)',
      'p2_1', 'Clause of loan agreement relating to engagement of recovery agents',
      'p2_2', 'Clause of loan agreement which details grievance redressal mechanism',
      'p2_3', 'Phone number and email id of the nodal grievance redressal officer',
      'p2_4', 'Whether the loan is, or in future may be, subject to transfer to other REs or securitisation',
      'p2_5', 'Collaborative lending arrangements',
      'p2_6', 'Digital loans: cooling off / look-up period during which the borrower shall not be charged any penalty on prepayment',
      'validity', 'Validity of this Key Facts Statement',
      'valid_from', 'Valid from',
      'valid_until', 'Valid until',
      'footer_lender', 'Issued by the lender named above. Prepared with Udofin as the lender''s service provider. This statement is not an approval by the Reserve Bank of India.',
      'yes', 'Yes',
      'no', 'No',
      'na', 'Not applicable')),
  'draft');
