-- =============================================================================================
-- Phase 04 (addendum A): the only write path into the onboarding schema.
--
-- Every function is SECURITY DEFINER with a pinned search_path, checks the caller's permission
-- first (before revealing whether anything exists), then the business rule. Rules that matter:
--   * platform-side writes need `onboarding.manage` / `onboarding.approve` AND an MFA session;
--   * lender-side writes need `onboarding.submit` in that lender, and nothing else;
--   * nobody reviews, verifies, approves or activates a record they contributed to;
--   * "unconfirmed" values can never be verified; evidence is mandatory for verification;
--   * gates move one step at a time, by a request and an independent decision;
--   * history is never deleted: changes create versions or new rows.
-- Error codes: 42501 not authorised, P0002 not found, 22023 bad input, 55000 rule/state, 23505 duplicate.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
create or replace function private.ob_require_manage()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_platform_permission('onboarding.manage') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
end
$$;

create or replace function private.ob_require_approve()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_platform_permission('onboarding.approve') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
end
$$;

-- Which side of the engagement the caller acts for in this lender: 'platform' or 'lender'.
create or replace function private.ob_side(p_lender uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.has_platform_permission('onboarding.manage') then
    perform private.require_aal2();
    return 'platform';
  end if;
  if p_lender in (select private.orgs_with_permission('onboarding.submit')) then
    return 'lender';
  end if;
  raise exception 'not authorised' using errcode = '42501';
end
$$;

create or replace function private.ob_assert_lender(p_lender uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from tenancy.organizations o where o.id = p_lender and o.kind = 'lender' and o.status <> 'offboarded') then
    raise exception 'lender not found' using errcode = 'P0002';
  end if;
end
$$;

create or replace function private.ob_check_keys(p_data jsonb, p_allowed text[])
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_bad text;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'a JSON object is required' using errcode = '22023';
  end if;
  select string_agg(k, ', ') into v_bad from jsonb_object_keys(p_data) k where k <> all (p_allowed);
  if v_bad is not null then
    raise exception 'unknown or not permitted field(s): %', v_bad using errcode = '22023';
  end if;
end
$$;

-- A reviewer must not have contributed to the record they review.
create or replace function private.ob_assert_independent(p_contributors uuid[], p_what text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if (select auth.uid()) = any (coalesce(p_contributors, '{}')) then
    raise exception 'you contributed to this record and cannot also %', p_what
      using errcode = '42501', hint = 'self_approval';
  end if;
end
$$;

create or replace function onboarding.stage_order(p_stage text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_stage
    when 'profile_created' then 1 when 'institution_verified' then 2 when 'approved_for_onboarding' then 3
    when 'contract_onboarded' then 4 when 'service_scope_agreed' then 5 when 'product_config_completed' then 6
    when 'product_config_approved' then 7 when 'integration_tested' then 8 when 'production_ready_approved' then 9
    when 'activated' then 10 else null end
$$;

-- ---------------------------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------------------------
create or replace function onboarding.register_document(
  p_lender uuid, p_purpose text, p_label text, p_storage_key text, p_sha256 text, p_size_bytes bigint, p_mime_type text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.ob_side(p_lender);
  perform private.ob_assert_lender(p_lender);
  insert into onboarding.documents (lender_org_id, purpose, label, storage_key, sha256, size_bytes, mime_type, uploaded_by)
  values (p_lender, p_purpose, p_label, p_storage_key, p_sha256, p_size_bytes, p_mime_type, (select auth.uid()))
  returning id into v_id;
  return v_id;
end
$$;

-- Authorised retrieval: returns the opaque storage key only to a reader of that lender, and records
-- the access (an access to a lender document is itself evidence).
create or replace function onboarding.document_for_download(p_id uuid)
returns table (storage_key text, mime_type text, sha256 text, size_bytes bigint, label text, scan_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc onboarding.documents;
  v_actor audit.actor_type;
begin
  select * into v_doc from onboarding.documents d where d.id = p_id;
  if not found or v_doc.lender_org_id not in (select private.orgs_with_permission('onboarding.read')) then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  if v_doc.scan_status = 'infected' then
    raise exception 'document is quarantined' using errcode = '55000', hint = 'document_quarantined';
  end if;
  v_actor := case when private.has_platform_permission('onboarding.read') then 'platform' else 'staff' end::audit.actor_type;
  insert into audit.events (actor_type, actor_user_id, tenant_org_id, action, entity_type, entity_id, metadata)
  values (v_actor, (select auth.uid()), v_doc.lender_org_id, 'onboarding.documents.download', 'onboarding_documents', v_doc.id::text,
          jsonb_build_object('purpose', v_doc.purpose));
  return query select v_doc.storage_key, v_doc.mime_type, v_doc.sha256, v_doc.size_bytes, v_doc.label, v_doc.scan_status;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Institution profile and verification
-- ---------------------------------------------------------------------------------------------
create or replace function onboarding.profile_create(p_lender uuid, p_category text, p_data jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_cat onboarding.institution_categories;
begin
  perform private.ob_require_manage();
  perform private.ob_assert_lender(p_lender);
  perform private.ob_check_keys(p_data, array['regulator', 'registration_no', 'cin', 'licence_type', 'licence_issued_on',
    'licence_valid_until', 'licence_status', 'notes']);
  select * into v_cat from onboarding.institution_categories where key = p_category and active;
  if not found then
    raise exception 'unknown institution category' using errcode = '22023';
  end if;
  insert into onboarding.lender_profiles (lender_org_id, category_key, regulator, registration_no, cin, licence_type,
    licence_issued_on, licence_valid_until, licence_status, notes, contributors, created_by)
  select p_lender, p_category, coalesce(r.regulator, v_cat.regulator), r.registration_no, r.cin, r.licence_type,
         r.licence_issued_on, r.licence_valid_until, coalesce(r.licence_status, 'unknown'), r.notes, array[v_uid], v_uid
  from jsonb_populate_record(null::onboarding.lender_profiles, p_data) r;
  insert into onboarding.lender_gates (lender_org_id) values (p_lender);
  return p_lender;
end
$$;

create or replace function onboarding.profile_update(p_lender uuid, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_side text := private.ob_side(p_lender);
  v_old onboarding.lender_profiles;
  v_merged jsonb;
  v_material boolean;
begin
  perform private.ob_assert_lender(p_lender);
  perform private.ob_check_keys(p_data, case v_side
    when 'platform' then array['category_key', 'regulator', 'registration_no', 'cin', 'licence_type', 'licence_issued_on', 'licence_valid_until', 'licence_status', 'notes']
    else array['regulator', 'registration_no', 'cin', 'licence_type', 'licence_issued_on', 'licence_valid_until', 'licence_status', 'notes'] end);
  select * into v_old from onboarding.lender_profiles where lender_org_id = p_lender for update;
  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
  if p_data ? 'category_key' and not exists (select 1 from onboarding.institution_categories where key = p_data ->> 'category_key' and active) then
    raise exception 'unknown institution category' using errcode = '22023';
  end if;
  v_merged := to_jsonb(v_old) || p_data;
  v_material := (v_merged - 'notes') is distinct from (to_jsonb(v_old) - 'notes');
  update onboarding.lender_profiles t set
    category_key = r.category_key, regulator = r.regulator, registration_no = r.registration_no, cin = r.cin,
    licence_type = r.licence_type, licence_issued_on = r.licence_issued_on, licence_valid_until = r.licence_valid_until,
    licence_status = r.licence_status, notes = r.notes,
    contributors = onboarding.append_unique(t.contributors, v_uid),
    -- Changing identity facts voids any earlier check of them.
    verification_status = case when v_material and t.verification_status in ('verified', 'submitted') then 'unverified' else t.verification_status end,
    verified_by = case when v_material then null else t.verified_by end,
    verified_at = case when v_material then null else t.verified_at end,
    last_verified_on = case when v_material then null else t.last_verified_on end,
    verification_requested_by = case when v_material then null else t.verification_requested_by end
  from jsonb_populate_record(null::onboarding.lender_profiles, v_merged) r
  where t.lender_org_id = p_lender;
end
$$;

create or replace function onboarding.verification_submit(p_lender uuid, p_evidence uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  perform private.ob_side(p_lender);
  perform private.ob_assert_lender(p_lender);
  if not exists (select 1 from onboarding.documents d where d.id = p_evidence and d.lender_org_id = p_lender) then
    raise exception 'evidence document not found for this lender' using errcode = '22023';
  end if;
  update onboarding.lender_profiles set
    verification_status = 'submitted', verification_evidence_id = p_evidence, verification_requested_by = v_uid,
    verification_requested_at = now(), verified_by = null, verified_at = null, last_verified_on = null,
    contributors = onboarding.append_unique(contributors, v_uid)
  where lender_org_id = p_lender and verification_status in ('unverified', 'rejected', 'expired');
  if not found then
    raise exception 'no profile awaiting verification evidence' using errcode = '55000';
  end if;
end
$$;

create or replace function onboarding.verification_decide(p_lender uuid, p_approve boolean, p_note text, p_reverify_by date default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_p onboarding.lender_profiles;
begin
  perform private.ob_require_approve();
  select * into v_p from onboarding.lender_profiles where lender_org_id = p_lender for update;
  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
  if v_p.verification_status <> 'submitted' then
    raise exception 'profile is %, not submitted for verification', v_p.verification_status using errcode = '55000';
  end if;
  perform private.ob_assert_independent(v_p.contributors, 'verify it');
  if p_approve then
    if v_p.registration_no is null or v_p.licence_status <> 'active' then
      raise exception 'a profile without a registration number and an active licence status cannot be verified' using errcode = '55000';
    end if;
    if v_p.licence_valid_until is not null and v_p.licence_valid_until < current_date then
      raise exception 'the recorded licence validity has passed' using errcode = '55000';
    end if;
    update onboarding.lender_profiles set verification_status = 'verified', verified_by = v_uid, verified_at = now(),
      last_verified_on = current_date, reverify_by = p_reverify_by, verification_note = p_note
    where lender_org_id = p_lender;
  else
    if p_note is null or length(trim(p_note)) < 10 then
      raise exception 'a rejection needs a reason' using errcode = '22023';
    end if;
    update onboarding.lender_profiles set verification_status = 'rejected', verification_note = p_note
    where lender_org_id = p_lender;
  end if;
end
$$;

-- Compliance sign-off for a category (e.g. banks, UCBs) before any lender in it can be activated.
create or replace function onboarding.category_signoff(p_key text, p_source_ref text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_platform_permission('onboarding.compliance_signoff') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
  if p_source_ref is null or length(trim(p_source_ref)) < 10 then
    raise exception 'cite the primary source reviewed (title and date)' using errcode = '22023';
  end if;
  update onboarding.institution_categories set activation_allowed = true, signoff_by = (select auth.uid()),
    signoff_at = now(), signoff_source_ref = p_source_ref
  where key = p_key and active;
  if not found then
    raise exception 'category not found' using errcode = 'P0002';
  end if;
end
$$;

create or replace function onboarding.category_revoke_signoff(p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_platform_permission('onboarding.compliance_signoff') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
  update onboarding.institution_categories set activation_allowed = false, signoff_by = null, signoff_at = null,
    signoff_source_ref = null
  where key = p_key;
  if not found then
    raise exception 'category not found' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Accounting framework and Ind AS status
-- ---------------------------------------------------------------------------------------------
create or replace function onboarding.accounting_save_draft(p_lender uuid, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_open onboarding.accounting_profiles;
  v_latest onboarding.accounting_profiles;
  v_merged jsonb;
  v_id uuid;
begin
  perform private.ob_side(p_lender);
  perform private.ob_assert_lender(p_lender);
  perform private.ob_check_keys(p_data, array['accounting_framework', 'ind_as_applicability', 'ind_as_implementation_status',
    'applicability_basis', 'applicability_basis_note', 'effective_fy', 'effective_date', 'statement_scope', 'listed_status',
    'group_relationships', 'net_worth_paise', 'net_worth_measured_on', 'net_worth_fy', 'confirmation_source',
    'evidence_document_id', 'notes', 'next_review_on']);
  if not exists (select 1 from onboarding.lender_profiles where lender_org_id = p_lender) then
    raise exception 'create the institution profile first' using errcode = '55000';
  end if;

  select * into v_open from onboarding.accounting_profiles
  where lender_org_id = p_lender and status in ('draft', 'submitted') for update;
  if found and v_open.status = 'submitted' then
    raise exception 'a version is awaiting review; wait for the decision' using errcode = '55000';
  end if;

  if found then
    v_merged := to_jsonb(v_open) || p_data;
    update onboarding.accounting_profiles t set
      accounting_framework = r.accounting_framework, ind_as_applicability = r.ind_as_applicability,
      ind_as_implementation_status = r.ind_as_implementation_status, applicability_basis = r.applicability_basis,
      applicability_basis_note = r.applicability_basis_note, effective_fy = r.effective_fy, effective_date = r.effective_date,
      statement_scope = r.statement_scope, listed_status = r.listed_status, group_relationships = r.group_relationships,
      net_worth_paise = r.net_worth_paise, net_worth_measured_on = r.net_worth_measured_on, net_worth_fy = r.net_worth_fy,
      confirmation_source = r.confirmation_source, evidence_document_id = r.evidence_document_id, notes = r.notes,
      next_review_on = r.next_review_on, contributors = onboarding.append_unique(t.contributors, v_uid)
    from jsonb_populate_record(null::onboarding.accounting_profiles, v_merged) r
    where t.id = v_open.id;
    return v_open.id;
  end if;

  -- A new version starts from the latest one (so the lender only edits what changed) but never
  -- inherits its evidence, reviewer or verification.
  select * into v_latest from onboarding.accounting_profiles where lender_org_id = p_lender order by version_no desc limit 1;
  v_merged := case when v_latest.id is null then '{}'::jsonb else to_jsonb(v_latest) - 'evidence_document_id' end || p_data;
  insert into onboarding.accounting_profiles (lender_org_id, version_no, accounting_framework, ind_as_applicability,
    ind_as_implementation_status, applicability_basis, applicability_basis_note, effective_fy, effective_date, statement_scope,
    listed_status, group_relationships, net_worth_paise, net_worth_measured_on, net_worth_fy, confirmation_source,
    evidence_document_id, notes, next_review_on, contributors, created_by)
  select p_lender, coalesce(v_latest.version_no, 0) + 1,
         coalesce(r.accounting_framework, 'to_be_confirmed'), coalesce(r.ind_as_applicability, 'to_be_confirmed'),
         coalesce(r.ind_as_implementation_status, 'to_be_confirmed'), coalesce(r.applicability_basis, 'to_be_confirmed'),
         r.applicability_basis_note, r.effective_fy, r.effective_date, coalesce(r.statement_scope, 'to_be_confirmed'),
         coalesce(r.listed_status, 'to_be_confirmed'), r.group_relationships, r.net_worth_paise, r.net_worth_measured_on,
         r.net_worth_fy, coalesce(r.confirmation_source, 'to_be_confirmed'), r.evidence_document_id, r.notes, r.next_review_on,
         array[v_uid], v_uid
  from jsonb_populate_record(null::onboarding.accounting_profiles, v_merged) r
  returning id into v_id;
  return v_id;
end
$$;

create or replace function onboarding.accounting_submit(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row onboarding.accounting_profiles;
begin
  select * into v_row from onboarding.accounting_profiles where id = p_id for update;
  if not found then
    raise exception 'accounting profile not found' using errcode = 'P0002';
  end if;
  perform private.ob_side(v_row.lender_org_id);
  if v_row.status <> 'draft' then
    raise exception 'only a draft can be submitted' using errcode = '55000';
  end if;
  update onboarding.accounting_profiles set status = 'submitted', submitted_by = v_uid, submitted_at = now(),
    contributors = onboarding.append_unique(contributors, v_uid)
  where id = p_id;
end
$$;

create or replace function onboarding.accounting_decide(p_id uuid, p_approve boolean, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row onboarding.accounting_profiles;
begin
  perform private.ob_require_approve();
  select * into v_row from onboarding.accounting_profiles where id = p_id for update;
  if not found then
    raise exception 'accounting profile not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'submitted' then
    raise exception 'profile is %, not submitted', v_row.status using errcode = '55000';
  end if;
  perform private.ob_assert_independent(v_row.contributors, 'review it');
  if p_approve then
    if v_row.evidence_document_id is null then
      raise exception 'evidence is required to verify an accounting profile' using errcode = '55000', hint = 'evidence_required';
    end if;
    if v_row.ind_as_applicability = 'to_be_confirmed' or v_row.confirmation_source = 'to_be_confirmed'
       or v_row.accounting_framework = 'to_be_confirmed' then
      raise exception 'an unconfirmed value cannot be verified' using errcode = '55000', hint = 'unconfirmed_not_verifiable';
    end if;
    update onboarding.accounting_profiles set status = 'superseded'
    where lender_org_id = v_row.lender_org_id and status = 'verified';
    update onboarding.accounting_profiles set status = 'verified', reviewed_by = v_uid, reviewed_at = now(),
      last_verified_on = current_date, review_note = p_note
    where id = p_id;
  else
    if p_note is null or length(trim(p_note)) < 10 then
      raise exception 'a rejection needs a reason' using errcode = '22023';
    end if;
    update onboarding.accounting_profiles set status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_note = p_note
    where id = p_id;
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Contracts
-- ---------------------------------------------------------------------------------------------
create or replace function onboarding.contract_record(p_lender uuid, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.ob_require_manage();
  perform private.ob_assert_lender(p_lender);
  perform private.ob_check_keys(p_data, array['contract_type', 'reference', 'executed_on', 'effective_from', 'effective_until',
    'document_id', 'status', 'note']);
  if coalesce(p_data ->> 'status', 'draft') not in ('draft', 'executed') then
    raise exception 'a contract is recorded as draft or executed' using errcode = '22023';
  end if;
  insert into onboarding.lender_contracts (lender_org_id, contract_type, reference, executed_on, effective_from, effective_until,
    document_id, status, note, recorded_by)
  select p_lender, r.contract_type, r.reference, r.executed_on, r.effective_from, r.effective_until, r.document_id,
         coalesce(r.status, 'draft'), r.note, (select auth.uid())
  from jsonb_populate_record(null::onboarding.lender_contracts, p_data) r
  returning id into v_id;
  return v_id;
end
$$;

create or replace function onboarding.contract_verify(p_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row onboarding.lender_contracts;
begin
  perform private.ob_require_approve();
  select * into v_row from onboarding.lender_contracts where id = p_id for update;
  if not found then
    raise exception 'contract not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'executed' or v_row.verified_by is not null then
    raise exception 'only an executed, unverified contract can be verified' using errcode = '55000';
  end if;
  if v_row.recorded_by = (select auth.uid()) then
    raise exception 'the person who recorded a contract cannot verify it' using errcode = '42501', hint = 'self_approval';
  end if;
  if p_approve then
    update onboarding.lender_contracts set verified_by = (select auth.uid()), verified_at = now(),
      note = coalesce(p_note, note) where id = p_id;
  else
    if p_note is null or length(trim(p_note)) < 10 then
      raise exception 'a rejection needs a reason' using errcode = '22023';
    end if;
    update onboarding.lender_contracts set status = 'draft', note = p_note where id = p_id;
  end if;
end
$$;

create or replace function onboarding.contract_end(p_id uuid, p_status text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.ob_require_approve();
  if p_status not in ('expired', 'terminated') or p_note is null or length(trim(p_note)) < 10 then
    raise exception 'give a status of expired or terminated and a reason' using errcode = '22023';
  end if;
  update onboarding.lender_contracts set status = p_status, note = p_note where id = p_id and status = 'executed';
  if not found then
    raise exception 'executed contract not found' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Services, scope and responsibilities
-- ---------------------------------------------------------------------------------------------
create or replace function private.ob_service_keys(p_side text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_side
    when 'platform' then array['requested_scope', 'proposed_scope', 'agreed_scope', 'responsible_party', 'accountable_party',
      'supporting_parties', 'shared_allocation', 'prerequisites', 'data_exchanged', 'permitted_purpose', 'system_of_record',
      'integration_requirements', 'sla_summary', 'escalation_path', 'contract_reference', 'effective_from', 'review_on']
    else array['requested_scope', 'prerequisites', 'system_of_record', 'integration_requirements', 'escalation_path'] end
$$;

create or replace function onboarding.service_create(p_lender uuid, p_category text, p_title text, p_data jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_side text := private.ob_side(p_lender);
  v_service uuid;
begin
  perform private.ob_assert_lender(p_lender);
  perform private.ob_check_keys(p_data, private.ob_service_keys(v_side));
  if not exists (select 1 from onboarding.service_categories where key = p_category and active) then
    raise exception 'unknown service category' using errcode = '22023';
  end if;
  insert into onboarding.lender_services (lender_org_id, category_key, title, created_by)
  values (p_lender, p_category, p_title, v_uid) returning id into v_service;
  insert into onboarding.service_versions (lender_org_id, service_id, version_no, requested_scope, proposed_scope, agreed_scope,
    responsible_party, accountable_party, supporting_parties, shared_allocation, prerequisites, data_exchanged, permitted_purpose,
    system_of_record, integration_requirements, sla_summary, escalation_path, contract_reference, effective_from, review_on,
    contributors, created_by)
  select p_lender, v_service, 1, r.requested_scope, r.proposed_scope, r.agreed_scope,
         coalesce(r.responsible_party, 'lender'), coalesce(r.accountable_party, 'lender'), coalesce(r.supporting_parties, '{}'),
         r.shared_allocation, r.prerequisites, r.data_exchanged, r.permitted_purpose,
         coalesce(r.system_of_record, 'to_be_confirmed'), r.integration_requirements, r.sla_summary, r.escalation_path,
         r.contract_reference, r.effective_from, r.review_on, array[v_uid], v_uid
  from jsonb_populate_record(null::onboarding.service_versions, p_data) r;
  return v_service;
end
$$;

-- Edits the open version in place (acknowledgements are withdrawn), or - when the current version
-- is already agreed or live - starts a new version, leaving the live one untouched until the new
-- one is agreed and activated by independent people.
create or replace function onboarding.service_revise(p_service uuid, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_svc onboarding.lender_services;
  v_cur onboarding.service_versions;
  v_side text;
  v_merged jsonb;
  v_id uuid;
begin
  select * into v_svc from onboarding.lender_services where id = p_service;
  if not found then
    raise exception 'service not found' using errcode = 'P0002';
  end if;
  v_side := private.ob_side(v_svc.lender_org_id);
  perform private.ob_check_keys(p_data, private.ob_service_keys(v_side));
  select * into v_cur from onboarding.service_versions where service_id = p_service
    and status in ('proposed', 'under_discussion') for update;
  if found then
    v_merged := to_jsonb(v_cur) || p_data;
    update onboarding.service_versions t set
      requested_scope = r.requested_scope, proposed_scope = r.proposed_scope, agreed_scope = r.agreed_scope,
      responsible_party = r.responsible_party, accountable_party = r.accountable_party,
      supporting_parties = r.supporting_parties, shared_allocation = r.shared_allocation, prerequisites = r.prerequisites,
      data_exchanged = r.data_exchanged, permitted_purpose = r.permitted_purpose, system_of_record = r.system_of_record,
      integration_requirements = r.integration_requirements, sla_summary = r.sla_summary, escalation_path = r.escalation_path,
      contract_reference = r.contract_reference, effective_from = r.effective_from, review_on = r.review_on,
      status = 'under_discussion', lender_agreed_by = null, lender_agreed_at = null, udofin_agreed_by = null,
      udofin_agreed_at = null, contributors = onboarding.append_unique(t.contributors, v_uid)
    from jsonb_populate_record(null::onboarding.service_versions, v_merged) r
    where t.id = v_cur.id;
    return v_cur.id;
  end if;

  select * into v_cur from onboarding.service_versions where service_id = p_service
    and status in ('agreed', 'active', 'suspended') order by version_no desc limit 1;
  if not found then
    raise exception 'this service has no version that can be revised' using errcode = '55000';
  end if;
  v_merged := (to_jsonb(v_cur) - 'agreed_scope') || p_data;
  insert into onboarding.service_versions (lender_org_id, service_id, version_no, status, requested_scope, proposed_scope,
    agreed_scope, responsible_party, accountable_party, supporting_parties, shared_allocation, prerequisites, data_exchanged,
    permitted_purpose, system_of_record, integration_requirements, sla_summary, escalation_path, contract_reference,
    effective_from, review_on, contributors, created_by)
  select v_cur.lender_org_id, p_service, (select max(version_no) from onboarding.service_versions where service_id = p_service) + 1,
         'proposed', r.requested_scope, r.proposed_scope, r.agreed_scope, r.responsible_party, r.accountable_party,
         r.supporting_parties, r.shared_allocation, r.prerequisites, r.data_exchanged, r.permitted_purpose, r.system_of_record,
         r.integration_requirements, r.sla_summary, r.escalation_path, r.contract_reference, r.effective_from, r.review_on,
         array[v_uid], v_uid
  from jsonb_populate_record(null::onboarding.service_versions, v_merged) r
  returning id into v_id;
  return v_id;
end
$$;

create or replace function onboarding.service_agree(p_version uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row onboarding.service_versions;
  v_lender_side boolean;
begin
  select * into v_row from onboarding.service_versions where id = p_version for update;
  if not found then
    raise exception 'service version not found' using errcode = 'P0002';
  end if;
  if v_row.status not in ('proposed', 'under_discussion') then
    raise exception 'version is %, not open for agreement', v_row.status using errcode = '55000';
  end if;
  if v_row.agreed_scope is null then
    raise exception 'the final agreed scope must be written before either side agrees' using errcode = '55000', hint = 'agreed_scope_required';
  end if;
  v_lender_side := v_row.lender_org_id in (select private.orgs_with_permission('onboarding.submit'));
  if v_lender_side then
    update onboarding.service_versions set lender_agreed_by = v_uid, lender_agreed_at = now() where id = p_version;
  else
    perform private.ob_require_approve();
    perform private.ob_assert_independent(v_row.contributors, 'agree it for Udofin');
    update onboarding.service_versions set udofin_agreed_by = v_uid, udofin_agreed_at = now() where id = p_version;
  end if;
  update onboarding.service_versions set status = 'agreed'
  where id = p_version and lender_agreed_by is not null and udofin_agreed_by is not null;
  return (select status from onboarding.service_versions where id = p_version);
end
$$;

create or replace function onboarding.service_activate(p_version uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row onboarding.service_versions;
  v_stage text;
begin
  perform private.ob_require_approve();
  select * into v_row from onboarding.service_versions where id = p_version for update;
  if not found then
    raise exception 'service version not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'agreed' then
    raise exception 'only an agreed version can be activated (it is %)', v_row.status using errcode = '55000';
  end if;
  if v_row.udofin_agreed_by = v_uid or v_uid = any (v_row.contributors) then
    raise exception 'activation needs someone who did not draft or agree the version' using errcode = '42501', hint = 'self_approval';
  end if;
  select stage into v_stage from onboarding.lender_gates where lender_org_id = v_row.lender_org_id;
  if v_stage is null or not (v_stage = 'activated' or coalesce(onboarding.stage_order(v_stage), 0) >= onboarding.stage_order('contract_onboarded')) then
    raise exception 'the lender has not completed contractual onboarding, or the engagement is not in force' using errcode = '55000', hint = 'gate_not_met';
  end if;
  update onboarding.service_versions set status = 'superseded'
  where service_id = v_row.service_id and status in ('active', 'suspended') and id <> p_version;
  update onboarding.service_versions set status = 'active', activated_by = v_uid, activated_at = now() where id = p_version;
end
$$;

create or replace function onboarding.service_change_state(p_version uuid, p_to text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row onboarding.service_versions;
begin
  perform private.ob_require_approve();
  if p_to not in ('suspended', 'active', 'terminated') or p_note is null or length(trim(p_note)) < 10 then
    raise exception 'give a target state (suspended, active, terminated) and a reason' using errcode = '22023';
  end if;
  select * into v_row from onboarding.service_versions where id = p_version for update;
  if not found then
    raise exception 'service version not found' using errcode = 'P0002';
  end if;
  if not ((v_row.status = 'active' and p_to in ('suspended', 'terminated'))
          or (v_row.status = 'suspended' and p_to in ('active', 'terminated'))
          or (v_row.status = 'agreed' and p_to = 'terminated')) then
    raise exception 'cannot move a % service version to %', v_row.status, p_to using errcode = '55000';
  end if;
  update onboarding.service_versions set status = p_to, status_note = p_note where id = p_version;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Requirements register
-- ---------------------------------------------------------------------------------------------
create or replace function onboarding.requirements_generate(p_lender uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cat text;
  v_n integer := 0;
  v_t onboarding.requirement_templates;
  v_svc record;
  v_rows integer;
begin
  perform private.ob_require_manage();
  perform private.ob_assert_lender(p_lender);
  select category_key into v_cat from onboarding.lender_profiles where lender_org_id = p_lender;
  if v_cat is null then
    raise exception 'create the institution profile first' using errcode = '55000';
  end if;
  for v_t in select * from onboarding.requirement_templates t where t.active
             and (t.applies_to_category_keys is null or v_cat = any (t.applies_to_category_keys)) loop
    if v_t.applies_to_service_category is null then
      insert into onboarding.lender_requirements (lender_org_id, template_key, title, description, mandatory, evidence_required, created_by)
      values (p_lender, v_t.key, v_t.title, v_t.description, v_t.mandatory, v_t.evidence_required, (select auth.uid()))
      on conflict do nothing;
      get diagnostics v_rows = row_count;
      v_n := v_n + v_rows;
    else
      for v_svc in select s.id from onboarding.lender_services s
                   where s.lender_org_id = p_lender and s.category_key = v_t.applies_to_service_category loop
        insert into onboarding.lender_requirements (lender_org_id, template_key, title, description, service_id, mandatory,
          evidence_required, created_by)
        values (p_lender, v_t.key, v_t.title, v_t.description, v_svc.id, v_t.mandatory, v_t.evidence_required, (select auth.uid()))
        on conflict do nothing;
        get diagnostics v_rows = row_count;
        v_n := v_n + v_rows;
      end loop;
    end if;
  end loop;
  return v_n;
end
$$;

create or replace function onboarding.requirement_create(p_lender uuid, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.ob_require_manage();
  perform private.ob_assert_lender(p_lender);
  perform private.ob_check_keys(p_data, array['title', 'description', 'service_id', 'product_id', 'integration_id', 'mandatory',
    'evidence_required', 'due_on']);
  insert into onboarding.lender_requirements (lender_org_id, title, description, service_id, product_id, integration_id, mandatory,
    evidence_required, due_on, created_by)
  select p_lender, r.title, r.description, r.service_id, r.product_id, r.integration_id, coalesce(r.mandatory, true),
         coalesce(r.evidence_required, false), r.due_on, (select auth.uid())
  from jsonb_populate_record(null::onboarding.lender_requirements, p_data) r
  returning id into v_id;
  return v_id;
end
$$;

create or replace function onboarding.requirement_add_dependency(p_requirement uuid, p_depends_on uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lender uuid;
begin
  perform private.ob_require_manage();
  select lender_org_id into v_lender from onboarding.lender_requirements where id = p_requirement;
  if v_lender is null then
    raise exception 'requirement not found' using errcode = 'P0002';
  end if;
  -- No cycles: the new prerequisite must not already depend (directly or not) on this requirement.
  if exists (
    with recursive chain as (
      select depends_on_id from onboarding.requirement_dependencies where requirement_id = p_depends_on
      union
      select d.depends_on_id from onboarding.requirement_dependencies d join chain c on d.requirement_id = c.depends_on_id
    ) select 1 from chain where depends_on_id = p_requirement
  ) then
    raise exception 'that dependency would create a cycle' using errcode = '55000';
  end if;
  insert into onboarding.requirement_dependencies (lender_org_id, requirement_id, depends_on_id, created_by)
  values (v_lender, p_requirement, p_depends_on, (select auth.uid()));
end
$$;

create or replace function onboarding.requirement_set_status(p_id uuid, p_to text, p_note text default null, p_evidence uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row onboarding.lender_requirements;
  v_side text;
  v_open_deps integer;
begin
  select * into v_row from onboarding.lender_requirements where id = p_id for update;
  if not found then
    raise exception 'requirement not found' using errcode = 'P0002';
  end if;
  if p_to in ('accepted', 'rejected', 'waived', 'not_applicable') then
    perform private.ob_require_approve();
    v_side := 'platform';
    if v_row.status in ('accepted', 'waived', 'not_applicable') then
      raise exception 'this requirement is already closed' using errcode = '55000';
    end if;
  else
    v_side := private.ob_side(v_row.lender_org_id);
  end if;
  if p_evidence is not null and not exists (
    select 1 from onboarding.documents d where d.id = p_evidence and d.lender_org_id = v_row.lender_org_id) then
    raise exception 'evidence document not found for this lender' using errcode = '22023';
  end if;

  if v_side = 'lender' then
    -- The lender can only work its own items forward.
    if not ((v_row.status in ('requested', 'rejected', 'expired') and p_to = 'in_progress')
            or (v_row.status in ('in_progress', 'requested') and p_to = 'submitted')) then
      raise exception 'the lender cannot move a % requirement to %', v_row.status, p_to using errcode = '55000';
    end if;
  else
    if p_to in ('accepted', 'rejected', 'waived', 'not_applicable') then
      perform private.ob_require_approve();
      if p_to in ('accepted', 'rejected') and v_row.status <> 'under_review' then
        raise exception 'only a requirement under review can be accepted or rejected' using errcode = '55000';
      end if;
      if p_to in ('rejected', 'waived', 'not_applicable') and (p_note is null or length(trim(p_note)) < 10) then
        raise exception 'a reason is required' using errcode = '22023';
      end if;
      if p_to in ('accepted', 'rejected') then
        perform private.ob_assert_independent(v_row.contributors, 'review it');
      end if;
      if p_to = 'accepted' then
        select count(*) into v_open_deps from onboarding.requirement_dependencies d
        join onboarding.lender_requirements q on q.id = d.depends_on_id
        where d.requirement_id = p_id and q.status not in ('accepted', 'waived', 'not_applicable');
        if v_open_deps > 0 then
          raise exception 'it depends on % requirement(s) that are not closed', v_open_deps using errcode = '55000', hint = 'dependency_open';
        end if;
      end if;
    elsif not ((v_row.status = 'not_requested' and p_to = 'requested')
               or (v_row.status = 'submitted' and p_to = 'under_review')
               or (v_row.status = 'accepted' and p_to = 'expired')
               or (v_row.status in ('requested', 'in_progress') and p_to in ('requested', 'in_progress', 'submitted'))) then
      raise exception 'cannot move a % requirement to %', v_row.status, p_to using errcode = '55000';
    end if;
  end if;

  update onboarding.lender_requirements set
    status = p_to,
    requested_on = case when p_to = 'requested' then current_date else requested_on end,
    received_on = case when p_to = 'submitted' then current_date else received_on end,
    submitted_by = case when p_to = 'submitted' then v_uid else submitted_by end,
    evidence_document_id = coalesce(p_evidence, evidence_document_id),
    reviewed_by = case when p_to in ('accepted', 'rejected', 'waived', 'not_applicable') then v_uid else reviewed_by end,
    reviewed_at = case when p_to in ('accepted', 'rejected', 'waived', 'not_applicable') then now() else reviewed_at end,
    comments = coalesce(p_note, comments),
    contributors = case when p_to in ('accepted', 'rejected', 'waived', 'not_applicable') then contributors
                        else onboarding.append_unique(contributors, v_uid) end
  where id = p_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Integrations
-- ---------------------------------------------------------------------------------------------
create or replace function onboarding.integration_create(p_lender uuid, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_uid uuid := (select auth.uid());
begin
  perform private.ob_side(p_lender);
  perform private.ob_assert_lender(p_lender);
  perform private.ob_check_keys(p_data, array['kind', 'name', 'purpose', 'service_id', 'notes']);
  insert into onboarding.integrations (lender_org_id, service_id, kind, name, purpose, notes, contributors, created_by)
  select p_lender, r.service_id, r.kind, r.name, r.purpose, r.notes, array[v_uid], v_uid
  from jsonb_populate_record(null::onboarding.integrations, p_data) r
  returning id into v_id;
  return v_id;
end
$$;

create or replace function onboarding.integration_record_result(p_id uuid, p_status text, p_evidence uuid, p_tested_on date, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row onboarding.integrations;
  v_uid uuid := (select auth.uid());
begin
  perform private.ob_require_manage();
  if p_status not in ('in_progress', 'tested', 'failed') then
    raise exception 'status must be in_progress, tested or failed' using errcode = '22023';
  end if;
  select * into v_row from onboarding.integrations where id = p_id for update;
  if not found then
    raise exception 'integration not found' using errcode = 'P0002';
  end if;
  if v_row.status = 'manual_exception' then
    raise exception 'this integration runs under an approved manual exception' using errcode = '55000';
  end if;
  update onboarding.integrations set status = p_status,
    test_evidence_document_id = case when p_status = 'tested' then p_evidence else test_evidence_document_id end,
    tested_by = case when p_status = 'tested' then v_uid else tested_by end,
    tested_on = case when p_status = 'tested' then coalesce(p_tested_on, current_date) else tested_on end,
    notes = coalesce(p_note, notes), contributors = onboarding.append_unique(contributors, v_uid)
  where id = p_id;
end
$$;

create or replace function onboarding.integration_request_exception(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  perform private.ob_require_manage();
  if p_reason is null or length(trim(p_reason)) < 20 then
    raise exception 'document why a manual process is acceptable (at least 20 characters)' using errcode = '22023';
  end if;
  update onboarding.integrations set manual_exception_reason = p_reason, exception_requested_by = v_uid,
    exception_approved_by = null, exception_approved_at = null,
    contributors = onboarding.append_unique(contributors, v_uid)
  where id = p_id and status in ('planned', 'in_progress', 'failed');
  if not found then
    raise exception 'integration not found or not open' using errcode = 'P0002';
  end if;
end
$$;

create or replace function onboarding.integration_decide_exception(p_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row onboarding.integrations;
  v_uid uuid := (select auth.uid());
begin
  perform private.ob_require_approve();
  select * into v_row from onboarding.integrations where id = p_id for update;
  if not found or v_row.exception_requested_by is null then
    raise exception 'no manual exception requested' using errcode = 'P0002';
  end if;
  if v_row.exception_requested_by = v_uid or v_uid = any (v_row.contributors) then
    raise exception 'the exception must be decided by someone who did not request it' using errcode = '42501', hint = 'self_approval';
  end if;
  if p_approve then
    update onboarding.integrations set status = 'manual_exception', exception_approved_by = v_uid, exception_approved_at = now()
    where id = p_id;
  else
    update onboarding.integrations set manual_exception_reason = null, exception_requested_by = null where id = p_id;
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Gates
-- ---------------------------------------------------------------------------------------------
create or replace function onboarding.gate_conditions(p_lender uuid, p_target text)
returns table (key text, satisfied boolean, detail text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile onboarding.lender_profiles;
  v_cat onboarding.institution_categories;
  c_profile boolean; c_verified boolean; c_licence boolean; c_accounting_rec boolean; c_accounting_ver boolean;
  c_contract boolean; c_scope boolean; c_service_active boolean; c_product boolean; c_product_appr boolean;
  c_integration boolean; c_req_gen boolean; c_req_closed boolean; c_category boolean; c_current boolean;
begin
  if p_lender not in (select private.orgs_with_permission('onboarding.read')) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  select * into v_profile from onboarding.lender_profiles where lender_org_id = p_lender;
  c_profile := v_profile.lender_org_id is not null;
  select c.* into v_cat from onboarding.institution_categories c where c.key = v_profile.category_key;
  c_verified := coalesce(v_profile.verification_status = 'verified', false);
  c_licence := c_profile and (v_profile.licence_valid_until is null or v_profile.licence_valid_until >= current_date);
  c_current := c_verified and c_licence and (v_profile.reverify_by is null or v_profile.reverify_by >= current_date);
  c_category := coalesce(v_cat.activation_allowed, false);
  c_accounting_rec := exists (select 1 from onboarding.accounting_profiles a where a.lender_org_id = p_lender);
  c_accounting_ver := exists (select 1 from onboarding.accounting_profiles a where a.lender_org_id = p_lender and a.status = 'verified');
  c_contract := exists (select 1 from onboarding.lender_contracts k where k.lender_org_id = p_lender
    and k.contract_type in ('master_services_agreement', 'lsp_agreement') and k.status = 'executed' and k.verified_by is not null
    and (k.effective_until is null or k.effective_until >= current_date));
  c_scope := exists (select 1 from onboarding.service_versions v where v.lender_org_id = p_lender and v.status in ('agreed', 'active'));
  c_service_active := exists (select 1 from onboarding.service_versions v where v.lender_org_id = p_lender and v.status = 'active');
  c_product := exists (select 1 from lending.loan_product_versions v where v.lender_org_id = p_lender);
  c_product_appr := exists (select 1 from lending.loan_product_versions v where v.lender_org_id = p_lender and v.status = 'approved');
  c_integration := exists (select 1 from onboarding.integrations i where i.lender_org_id = p_lender
    and (i.status = 'tested' or (i.status = 'manual_exception' and i.exception_approved_by is not null)));
  c_req_gen := exists (select 1 from onboarding.lender_requirements q where q.lender_org_id = p_lender);
  c_req_closed := not exists (select 1 from onboarding.lender_requirements q where q.lender_org_id = p_lender and q.mandatory
    and q.status not in ('accepted', 'waived', 'not_applicable'));

  return query
  select x.key, x.ok, x.detail from (values
    ('profile_exists', c_profile, 'institution profile recorded', array['institution_verified']),
    ('institution_verified', c_verified, 'institution profile verified with evidence by an independent reviewer', array['institution_verified']),
    ('licence_not_expired', c_licence, 'recorded licence validity has not passed', array['institution_verified']),
    ('accounting_profile_recorded', c_accounting_rec, 'an accounting framework / Ind AS status record exists (it may still be unconfirmed)', array['approved_for_onboarding']),
    ('verified_contract', c_contract, 'an executed master services or LSP agreement with an independent verification', array['contract_onboarded']),
    ('service_scope_agreed', c_scope, 'at least one service scope agreed by both sides', array['service_scope_agreed']),
    ('product_configured', c_product, 'at least one lender product version exists', array['product_config_completed']),
    ('product_version_approved', c_product_appr, 'at least one product version approved by the lender (maker-checker)', array['product_config_approved', 'production_ready_approved', 'activated']),
    ('integration_tested_or_excepted', c_integration, 'an integration passed testing, or a manual exception was independently approved', array['integration_tested', 'production_ready_approved', 'activated']),
    ('requirements_generated', c_req_gen, 'the requirements register has been generated', array['production_ready_approved', 'activated']),
    ('mandatory_requirements_closed', c_req_closed, 'every mandatory requirement is accepted, waived or not applicable', array['production_ready_approved', 'activated']),
    ('accounting_profile_verified', c_accounting_ver, 'the accounting framework / Ind AS status has been verified with evidence', array['production_ready_approved', 'activated']),
    ('category_activation_allowed', c_category, 'compliance has signed off the lender''s institution category', array['production_ready_approved', 'activated']),
    ('institution_verification_current', c_current, 'institution verification and licence are still current', array['production_ready_approved', 'activated']),
    ('verified_contract_current', c_contract, 'the verified contract is still in force', array['production_ready_approved', 'activated']),
    ('service_scope_in_force', c_scope, 'an agreed or active service scope exists', array['production_ready_approved']),
    ('service_active', c_service_active, 'at least one service version has been activated', array['activated'])
  ) as x (key, ok, detail, targets)
  where p_target = any (x.targets);
end
$$;

create or replace function onboarding.gate_request(p_lender uuid, p_target text, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gate onboarding.lender_gates;
  v_unmet text;
  v_id uuid;
  v_ok boolean;
begin
  perform private.ob_require_manage();
  perform private.ob_assert_lender(p_lender);
  select * into v_gate from onboarding.lender_gates where lender_org_id = p_lender for update;
  if not found then
    raise exception 'create the institution profile first' using errcode = '55000';
  end if;
  v_ok := case
    when p_target = 'suspended' then v_gate.stage = 'activated'
    when p_target = 'activated' and v_gate.stage = 'suspended' then true
    when p_target = 'deactivated' then v_gate.stage in ('activated', 'suspended')
    when p_target = 'terminated' then v_gate.stage <> 'terminated'
    else onboarding.stage_order(p_target) is not null and onboarding.stage_order(v_gate.stage) is not null
         and onboarding.stage_order(p_target) = onboarding.stage_order(v_gate.stage) + 1
  end;
  if not coalesce(v_ok, false) then
    raise exception 'a lender at stage % cannot be moved to %', v_gate.stage, p_target using errcode = '55000', hint = 'gate_order';
  end if;
  select string_agg(c.key, ', ' order by c.key) into v_unmet from onboarding.gate_conditions(p_lender, p_target) c where not c.satisfied;
  if v_unmet is not null then
    raise exception 'gate conditions not met: %', v_unmet using errcode = '55000', hint = 'gate_not_met';
  end if;
  insert into onboarding.gate_requests (lender_org_id, from_stage, target_stage, requested_by, request_note)
  values (p_lender, v_gate.stage, p_target, (select auth.uid()), p_note) returning id into v_id;
  return v_id;
end
$$;

create or replace function onboarding.gate_decide(p_request uuid, p_approve boolean, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_req onboarding.gate_requests;
  v_gate onboarding.lender_gates;
  v_snapshot jsonb;
  v_unmet text;
begin
  perform private.ob_require_approve();
  select * into v_req from onboarding.gate_requests where id = p_request for update;
  if not found then
    raise exception 'gate request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'request is %, not pending', v_req.status using errcode = '55000';
  end if;
  if v_req.requested_by = v_uid then
    raise exception 'a gate cannot be approved by the person who requested it' using errcode = '42501', hint = 'self_approval';
  end if;
  select * into v_gate from onboarding.lender_gates where lender_org_id = v_req.lender_org_id for update;
  if v_gate.stage <> v_req.from_stage then
    update onboarding.gate_requests set status = 'cancelled', decision_note = 'the lender moved on before this was decided' where id = p_request;
    raise exception 'the lender is no longer at stage %', v_req.from_stage using errcode = '55000', hint = 'gate_stale';
  end if;

  select coalesce(jsonb_object_agg(c.key, c.satisfied), '{}'::jsonb), string_agg(c.key, ', ' order by c.key) filter (where not c.satisfied)
    into v_snapshot, v_unmet
  from onboarding.gate_conditions(v_req.lender_org_id, v_req.target_stage) c;

  if not p_approve then
    if p_note is null or length(trim(p_note)) < 10 then
      raise exception 'a rejection needs a reason' using errcode = '22023';
    end if;
    update onboarding.gate_requests set status = 'rejected', decided_by = v_uid, decided_at = now(), decision_note = p_note,
      conditions_snapshot = v_snapshot where id = p_request;
    return v_gate.stage;
  end if;

  if v_unmet is not null then
    raise exception 'gate conditions not met: %', v_unmet using errcode = '55000', hint = 'gate_not_met';
  end if;
  update onboarding.gate_requests set status = 'approved', decided_by = v_uid, decided_at = now(), decision_note = p_note,
    conditions_snapshot = v_snapshot where id = p_request;
  update onboarding.lender_gates set stage = v_req.target_stage, stage_changed_at = now(),
    stage_before_suspension = case when v_req.target_stage = 'suspended' then v_gate.stage else null end
  where lender_org_id = v_req.lender_org_id;
  return v_req.target_stage;
end
$$;

create or replace function onboarding.gate_cancel(p_request uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.ob_require_manage();
  update onboarding.gate_requests set status = 'cancelled' where id = p_request and status = 'pending' and requested_by = (select auth.uid());
  if not found then
    raise exception 'no pending request of yours found' using errcode = 'P0002';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Borrower visibility: a lender's products are visible to borrowers only while the lender is live
-- (activated, not suspended/deactivated/terminated, organisation not suspended or offboarded).
-- ---------------------------------------------------------------------------------------------
create or replace function private.lender_is_live(p_lender uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from onboarding.lender_gates g
    join tenancy.organizations o on o.id = g.lender_org_id
    where g.lender_org_id = p_lender and g.stage = 'activated' and o.status in ('onboarding', 'active')
  )
$$;
grant execute on function private.lender_is_live(uuid) to authenticated, service_role;

-- The single surface for borrower-facing product discovery. Internal configuration stays hidden.
create view lending.borrower_visible_product_versions with (security_barrier = true) as
select v.id as version_id, v.product_id, v.lender_org_id, p.category_key, p.code, p.name, v.version,
       v.min_amount_minor, v.max_amount_minor, v.min_tenure_days, v.max_tenure_days, v.rate_type,
       v.min_annual_rate_bps, v.max_annual_rate_bps, v.effective_from
from lending.loan_product_versions v
join lending.loan_products p on p.id = v.product_id and p.lender_org_id = v.lender_org_id
where v.status = 'approved' and p.status = 'active' and private.lender_is_live(v.lender_org_id);
comment on view lending.borrower_visible_product_versions is
  'Approved product versions of live lenders only. Borrower-facing discovery must read this view, never the base tables. Owner: onboarding module.';
grant select on lending.borrower_visible_product_versions to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Grants: callable by signed-in users; every function checks its own permissions.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'onboarding' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end
$$;
