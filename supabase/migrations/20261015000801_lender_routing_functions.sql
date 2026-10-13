-- =============================================================================================
-- Phase 06, part 2: functions. Every write goes through one of these; users hold no DML on the
-- new tables. Functions read the caller from the token claim, never from input.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Small shared helpers
-- ---------------------------------------------------------------------------------------------
-- The version of the fixed minimum payload a lender may receive. A material change needs new consent.
create or replace function lending.payload_scope()
returns text language sql immutable set search_path = '' as $$ select 'minimum_payload_v1' $$;

create or replace function lending.audit_event(p_action text, p_entity_type text, p_entity_id text, p_meta jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into audit.events (actor_type, actor_user_id, action, entity_type, entity_id, metadata)
  values (case when (select auth.uid()) is null then 'system'
               when exists (select 1 from identity.borrowers b where b.user_id = (select auth.uid())) then 'borrower'
               else 'staff' end::audit.actor_type,
          (select auth.uid()), p_action, p_entity_type, p_entity_id, coalesce(p_meta, '{}'::jsonb))
$$;
revoke all on function lending.audit_event(text, text, text, jsonb) from public;

create or replace function private.routing_event(p_app uuid, p_lender uuid, p_event text, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into lending.routing_events (application_id, lender_org_id, event, detail, actor)
  values (p_app, p_lender, p_event, coalesce(p_detail, '{}'::jsonb), private.current_actor())
$$;
revoke all on function private.routing_event(uuid, uuid, text, jsonb) from public;

create or replace function private.try_timestamptz(p text)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then
    return null;
  end if;
  return p::timestamptz;
exception when others then
  return null;
end
$$;

-- A JSON number that is a whole number, or null. Offer figures are never rounded or reinterpreted.
create or replace function private.jint(p jsonb, k text)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p -> k) = 'number' and (p ->> k) ~ '^-?[0-9]{1,18}$' then (p ->> k)::bigint end
$$;

-- Returns NULL when the KFS link is acceptable, otherwise a short reason code.
create or replace function private.kfs_issue(p_url text, p_hosts text[])
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_host text;
begin
  if p_url is null or length(p_url) = 0 then return 'kfs_url_missing'; end if;
  if length(p_url) > 2048 or p_url !~* '^https://[a-z0-9.-]+(:443)?(/[^[:space:]\\]*)?$' or p_url ~ '/\.\./' or p_url ~ '/\.\.$' then
    return 'kfs_url_invalid';
  end if;
  v_host := lower(substring(p_url from '^https://([^/:]+)'));
  if p_hosts is null or cardinality(p_hosts) = 0 then return 'kfs_host_allowlist_missing'; end if;
  if not (v_host = any (p_hosts)) then return 'kfs_host_not_allowed'; end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Consent: the current wording for a lender, and whether consent is in force right now
-- ---------------------------------------------------------------------------------------------
create or replace function private.current_lender_notice(p_lender uuid, p_language text)
returns consent.notices
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v consent.notices;
begin
  select * into v from consent.notices n
  where n.purpose = 'share_with_lender' and n.lender_org_id = p_lender and n.status = 'published' and n.language = p_language
  order by n.version desc limit 1;
  if v.id is null and p_language <> 'en' then
    select * into v from consent.notices n
    where n.purpose = 'share_with_lender' and n.lender_org_id = p_lender and n.status = 'published' and n.language = 'en'
    order by n.version desc limit 1;
  end if;
  return v;
end
$$;
revoke all on function private.current_lender_notice(uuid, text) from public;

-- True only when the latest decision for this lender and request is "granted" on approved wording that is still the
-- latest published version in its language. A withdrawn, superseded or unapproved consent authorises nothing new.
create or replace function private.lender_consent_ok(p_borrower uuid, p_lender uuid, p_request uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select l.decision = 'granted' and n.status = 'published' and n.review_status = 'approved'
       and n.version = (select max(x.version) from consent.notices x
                         where x.purpose = 'share_with_lender' and x.lender_org_id = p_lender and x.language = n.language and x.status = 'published')
    from (select r.decision, r.notice_id from consent.records r join consent.notices nn on nn.id = r.notice_id
           where r.borrower_id = p_borrower and r.lender_org_id = p_lender and nn.purpose = 'share_with_lender'
             and r.evidence ->> 'loan_request_id' = p_request::text
           order by r.captured_at desc, r.id desc limit 1) l
    join consent.notices n on n.id = l.notice_id
  ), false)
$$;
revoke all on function private.lender_consent_ok(uuid, uuid, uuid) from public;

-- ---------------------------------------------------------------------------------------------
-- Connector configuration (platform staff)
-- ---------------------------------------------------------------------------------------------
create or replace function lending.set_lender_connector(
  p_lender uuid, p_kind text, p_status text, p_response_hours integer, p_min_validity_days integer,
  p_kfs_hosts text[], p_secret_ref text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_platform_permission('platform.lender_routing.manage') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
  if p_kind not in ('manual', 'api') then
    raise exception 'only manual and api connectors can be configured here' using errcode = '22023', hint = 'connector_kind_invalid';
  end if;
  if not exists (select 1 from tenancy.organizations o where o.id = p_lender and o.kind = 'lender') then
    raise exception 'lender not found' using errcode = 'P0002';
  end if;
  if p_status = 'active' and p_kind = 'api' and p_secret_ref is null then
    raise exception 'an api connector needs the name of its signing secret' using errcode = '22023', hint = 'signing_secret_required';
  end if;
  insert into lending.lender_connectors (lender_org_id, kind, status, response_hours, offer_min_validity_days, kfs_allowed_hosts, signing_secret_ref, updated_by)
  values (p_lender, p_kind, p_status, p_response_hours, p_min_validity_days, coalesce(p_kfs_hosts, '{}'), p_secret_ref, (select auth.uid()))
  on conflict (lender_org_id) do update set kind = excluded.kind, status = excluded.status, response_hours = excluded.response_hours,
    offer_min_validity_days = excluded.offer_min_validity_days, kfs_allowed_hosts = excluded.kfs_allowed_hosts,
    signing_secret_ref = excluded.signing_secret_ref, updated_by = excluded.updated_by, updated_at = now();
  perform lending.audit_event('lending.connector.configured', 'lender', p_lender::text,
    jsonb_build_object('kind', p_kind, 'status', p_status, 'response_hours', p_response_hours, 'min_validity_days', p_min_validity_days));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Offer-ordering rules (D-16). No rule is seeded: until one is approved the comparison cannot be served.
-- ---------------------------------------------------------------------------------------------
create or replace function lending.rule_in_force()
returns lending.matching_rule_versions
language sql
stable
security definer
set search_path = ''
as $$
  select r from lending.matching_rule_versions r where r.effective_from <= now() order by r.version desc limit 1
$$;
revoke all on function lending.rule_in_force() from public;

create or replace function lending.propose_matching_rule(p_summary text, p_metric text, p_sort_keys text[], p_alternatives text[], p_effective_from timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.has_platform_permission('platform.lender_routing.manage') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
  insert into lending.matching_rule_proposals (mechanism_summary, disclosed_metric, sort_keys, alternative_sorts, effective_from, proposed_by)
  values (p_summary, p_metric, p_sort_keys, coalesce(p_alternatives, '{}'), p_effective_from, (select auth.uid()))
  returning id into v_id;
  perform lending.audit_event('lending.rule.proposed', 'matching_rule_proposal', v_id::text);
  return v_id;
end
$$;

create or replace function lending.decide_matching_rule(p_id uuid, p_approve boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p lending.matching_rule_proposals;
  v_version uuid;
begin
  if not private.has_platform_permission('platform.lender_routing.manage') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
  select * into v_p from lending.matching_rule_proposals where id = p_id for update;
  if not found then raise exception 'proposal not found' using errcode = 'P0002'; end if;
  if v_p.status <> 'proposed' then
    raise exception 'proposal already decided' using errcode = '55000', hint = 'already_decided';
  end if;
  if v_p.proposed_by = (select auth.uid()) then
    raise exception 'a different person must decide' using errcode = '42501', hint = 'segregation_of_duties';
  end if;
  if p_approve then
    insert into lending.matching_rule_versions (version, mechanism_summary, disclosed_metric, effective_from, approved_by, sort_keys, alternative_sorts)
    values ((select coalesce(max(version), 0) + 1 from lending.matching_rule_versions), v_p.mechanism_summary, v_p.disclosed_metric,
            greatest(v_p.effective_from, now()), (select auth.uid()), v_p.sort_keys, v_p.alternative_sorts)
    returning id into v_version;
  end if;
  update lending.matching_rule_proposals set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = (select auth.uid()), decided_at = now(), resulting_version_id = v_version where id = p_id;
  perform lending.audit_event('lending.rule.decided', 'matching_rule_proposal', p_id::text, jsonb_build_object('approved', p_approve));
  return v_version;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Lender discovery and selection (borrower)
-- ---------------------------------------------------------------------------------------------
create or replace function lending.matching_products(p_request uuid)
returns table (lender_org_id uuid, lender_name text, version_id uuid, product_name text,
               min_amount_minor bigint, max_amount_minor bigint, min_tenure_days integer, max_tenure_days integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_req lending.loan_requests;
begin
  select * into v_req from lending.loan_requests r where r.id = p_request and r.borrower_id = v_borrower;
  if not found then raise exception 'request not found' using errcode = 'P0002'; end if;
  return query
  select v.lender_org_id, o.display_name::text, v.version_id, v.name::text,
         v.min_amount_minor, v.max_amount_minor, v.min_tenure_days, v.max_tenure_days
  from lending.borrower_visible_product_versions v
  join tenancy.organizations o on o.id = v.lender_org_id
  join lending.lender_connectors c on c.lender_org_id = v.lender_org_id and c.status = 'active'
  where v.category_key = v_req.category_key
    and v_req.requested_amount_minor between v.min_amount_minor and v.max_amount_minor
    and v_req.requested_tenure_days between v.min_tenure_days and v.max_tenure_days
    and not exists (select 1 from lending.applications a where a.loan_request_id = p_request and a.lender_org_id = v.lender_org_id)
  order by o.display_name, v.name;
end
$$;

create or replace function lending.select_lenders(p_request uuid, p_items jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_req lending.loan_requests;
  v_n integer;
  v_existing integer;
  v_sel uuid;
  r record;
  v_pv uuid;
  v_cnt integer;
begin
  select * into v_req from lending.loan_requests where id = p_request and borrower_id = v_borrower for update;
  if not found then raise exception 'request not found' using errcode = 'P0002'; end if;
  if v_req.status <> 'submitted' then
    raise exception 'the request must be submitted first' using errcode = '55000', hint = 'request_not_submitted';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid selection' using errcode = '22023', hint = 'invalid_selection';
  end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1 then raise exception 'choose at least one lender' using errcode = '22023', hint = 'selection_empty'; end if;
  if v_n > 5 then raise exception 'at most five lenders' using errcode = '22023', hint = 'too_many_lenders'; end if;
  -- The cap counts every lender ever routed for this request (withdrawn ones too), so repeating the call cannot raise it.
  select count(*) into v_existing from lending.applications where loan_request_id = p_request;
  if v_existing + v_n > 5 then raise exception 'at most five lenders per request' using errcode = '22023', hint = 'too_many_lenders'; end if;
  begin
    if (select count(distinct (e ->> 'lenderId')) from jsonb_array_elements(p_items) e) <> v_n then
      raise exception 'a lender can be chosen once' using errcode = '22023', hint = 'duplicate_lender';
    end if;
    update lending.lender_selection_items set status = 'removed'
      where selection_id in (select id from lending.lender_selections where loan_request_id = p_request and status = 'open') and status <> 'routed';
    update lending.lender_selections set status = 'cancelled', closed_at = now() where loan_request_id = p_request and status = 'open';
    insert into lending.lender_selections (loan_request_id, borrower_id) values (p_request, v_borrower) returning id into v_sel;
    for r in select (e ->> 'lenderId')::uuid as lender, nullif(e ->> 'productVersionId', '')::uuid as pv from jsonb_array_elements(p_items) e loop
      if exists (select 1 from lending.applications a where a.loan_request_id = p_request and a.lender_org_id = r.lender) then
        raise exception 'already sent to this lender' using errcode = '55000', hint = 'already_routed';
      end if;
      select count(*) into v_cnt from lending.matching_products(p_request) m where m.lender_org_id = r.lender;
      if v_cnt = 0 then raise exception 'lender not available' using errcode = '55000', hint = 'lender_not_available'; end if;
      v_pv := r.pv;
      if v_pv is null then
        if v_req.product_version_id is not null and exists (select 1 from lending.matching_products(p_request) m where m.lender_org_id = r.lender and m.version_id = v_req.product_version_id) then
          v_pv := v_req.product_version_id;
        elsif v_cnt = 1 then
          select m.version_id into v_pv from lending.matching_products(p_request) m where m.lender_org_id = r.lender;
        else
          raise exception 'choose a product for this lender' using errcode = '22023', hint = 'product_required';
        end if;
      elsif not exists (select 1 from lending.matching_products(p_request) m where m.lender_org_id = r.lender and m.version_id = v_pv) then
        raise exception 'that product is not available' using errcode = '55000', hint = 'product_unavailable';
      end if;
      insert into lending.lender_selection_items (selection_id, lender_org_id, product_version_id) values (v_sel, r.lender, v_pv);
    end loop;
  exception when invalid_text_representation then
    raise exception 'invalid selection' using errcode = '22023', hint = 'invalid_selection';
  end;
  perform lending.audit_event('lending.lenders.selected', 'lender_selection', v_sel::text, jsonb_build_object('count', v_n));
  return v_sel;
end
$$;

-- Per-lender consent (separate from the Phase 05 platform consents). The recipient and scope are part of the evidence.
create or replace function consent.record_lender_decision(
  p_request uuid, p_lender uuid, p_notice_id uuid, p_decision consent.decision, p_app_version text, p_screen text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_notice consent.notices;
  v_item lending.lender_selection_items;
  v_sel lending.lender_selections;
  v_id uuid;
begin
  if not exists (select 1 from lending.loan_requests r where r.id = p_request and r.borrower_id = v_borrower) then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  select * into v_notice from consent.notices where id = p_notice_id and status = 'published';
  if not found or v_notice.purpose <> 'share_with_lender' or v_notice.lender_org_id is distinct from p_lender then
    raise exception 'notice not found' using errcode = 'P0002';
  end if;
  select * into v_sel from lending.lender_selections where loan_request_id = p_request and borrower_id = v_borrower and status = 'open';
  if p_decision <> 'withdrawn' then
    select i.* into v_item from lending.lender_selection_items i
      where i.selection_id = v_sel.id and i.lender_org_id = p_lender and i.status in ('selected', 'consented');
    if v_item.id is null then
      raise exception 'choose the lender first' using errcode = '55000', hint = 'not_selected';
    end if;
  end if;
  if p_decision = 'granted' then
    if v_notice.review_status <> 'approved' then
      raise exception 'this wording has not been approved' using errcode = '55000', hint = 'wording_not_approved';
    end if;
    if v_notice.version < (select max(n.version) from consent.notices n
                            where n.purpose = 'share_with_lender' and n.lender_org_id = p_lender and n.language = v_notice.language and n.status = 'published') then
      raise exception 'a newer version of this notice is published' using errcode = '55000', hint = 'notice_superseded';
    end if;
  end if;
  insert into consent.records (borrower_id, notice_id, lender_org_id, decision, channel, app_version, evidence)
  values (v_borrower, p_notice_id, p_lender, p_decision, 'mobile_app', left(p_app_version, 40),
          jsonb_build_object('screen', left(coalesce(p_screen, 'unknown'), 40), 'notice_sha256', v_notice.body_sha256, 'language', v_notice.language,
                             'loan_request_id', p_request, 'selection_id', v_sel.id, 'scope', lending.payload_scope()))
  returning id into v_id;
  if p_decision = 'granted' then
    update lending.lender_selection_items set status = 'consented', consent_record_id = v_id where id = v_item.id;
  elsif p_decision = 'withdrawn' then
    perform private.apply_consent_withdrawal(v_borrower, p_lender, p_request);
  end if;
  perform lending.audit_event('consent.lender_recorded', 'consent_record', v_id::text,
    jsonb_build_object('decision', p_decision::text, 'lender_id', p_lender, 'notice_version', v_notice.version));
  return v_id;
end
$$;

-- Serialises with transmission through the routing row lock: whichever commits first wins, and the outcome is recorded.
create or replace function private.apply_consent_withdrawal(p_borrower uuid, p_lender uuid, p_request uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in select ar.application_id, ar.transmission_status from lending.application_routing ar
            join lending.applications a on a.id = ar.application_id
           where a.borrower_id = p_borrower and ar.lender_org_id = p_lender and ar.loan_request_id = p_request
           for update of ar loop
    if r.transmission_status in ('queued', 'uncertain') then
      update lending.application_routing set transmission_status = 'stopped_consent', consent_withdrawn_at = now() where application_id = r.application_id;
      perform set_config('udofin.transition_reason', 'consent_withdrawn', true);
      update lending.applications set status = 'withdrawn' where id = r.application_id and status = 'submitted';
      perform private.routing_event(r.application_id, p_lender, 'stopped_consent', jsonb_build_object('was_uncertain', r.transmission_status = 'uncertain'));
    elsif r.transmission_status in ('transmitting', 'transmitted', 'acknowledged') then
      update lending.application_routing set consent_withdrawn_at = coalesce(consent_withdrawn_at, now()) where application_id = r.application_id;
      -- Data already went out. The consequence for the lender's copy is a contractual and legal matter (D-41); we record it.
      perform private.routing_event(r.application_id, p_lender, 'consent_withdrawn_after_transmission', '{}'::jsonb);
    end if;
  end loop;
end
$$;
revoke all on function private.apply_consent_withdrawal(uuid, uuid, uuid) from public;

create or replace function lending.remove_selection_item(p_selection uuid, p_lender uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
begin
  update lending.lender_selection_items i set status = 'removed'
   where i.selection_id = p_selection and i.lender_org_id = p_lender and i.status in ('selected', 'consented')
     and exists (select 1 from lending.lender_selections s where s.id = i.selection_id and s.borrower_id = v_borrower and s.status = 'open');
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
end
$$;

-- Creates one application per consented lender, all or nothing, and queues transmission. The only creator of routed applications.
create or replace function lending.route_selection(p_selection uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_sel lending.lender_selections;
  v_req lending.loan_requests;
  v_n integer;
  v_existing integer;
  r record;
  v_c lending.lender_connectors;
  v_app uuid;
  v_consent uuid;
  v_out jsonb := '[]'::jsonb;
begin
  select * into v_sel from lending.lender_selections where id = p_selection and borrower_id = v_borrower for update;
  if not found then raise exception 'selection not found' using errcode = 'P0002'; end if;
  if v_sel.status <> 'open' then raise exception 'selection is closed' using errcode = '55000', hint = 'selection_closed'; end if;
  select * into v_req from lending.loan_requests where id = v_sel.loan_request_id for update;
  if v_req.status <> 'submitted' then raise exception 'the request is not open' using errcode = '55000', hint = 'request_not_submitted'; end if;
  select count(*) into v_n from lending.lender_selection_items where selection_id = p_selection and status in ('selected', 'consented');
  select count(*) into v_existing from lending.applications where loan_request_id = v_req.id;
  if v_n = 0 then raise exception 'choose at least one lender' using errcode = '22023', hint = 'selection_empty'; end if;
  if v_n + v_existing > 5 then raise exception 'at most five lenders per request' using errcode = '22023', hint = 'too_many_lenders'; end if;
  for r in select * from lending.lender_selection_items where selection_id = p_selection and status in ('selected', 'consented') order by created_at, id loop
    if not private.lender_consent_ok(v_borrower, r.lender_org_id, v_req.id) then
      raise exception 'current consent for this lender is required' using errcode = '55000', hint = 'consent_required', detail = r.lender_org_id::text;
    end if;
    select * into v_c from lending.lender_connectors c where c.lender_org_id = r.lender_org_id and c.status = 'active';
    if v_c.lender_org_id is null or not private.lender_is_live(r.lender_org_id) then
      raise exception 'lender not available' using errcode = '55000', hint = 'lender_not_available', detail = r.lender_org_id::text;
    end if;
    if not exists (select 1 from lending.borrower_visible_product_versions v
                    where v.version_id = r.product_version_id and v.lender_org_id = r.lender_org_id and v.category_key = v_req.category_key
                      and v_req.requested_amount_minor between v.min_amount_minor and v.max_amount_minor
                      and v_req.requested_tenure_days between v.min_tenure_days and v.max_tenure_days) then
      raise exception 'that product is not available' using errcode = '55000', hint = 'product_unavailable', detail = r.lender_org_id::text;
    end if;
    select rec.id into v_consent from consent.records rec join consent.notices n on n.id = rec.notice_id
      where rec.borrower_id = v_borrower and rec.lender_org_id = r.lender_org_id and n.purpose = 'share_with_lender'
        and rec.evidence ->> 'loan_request_id' = v_req.id::text and rec.decision = 'granted'
      order by rec.captured_at desc, rec.id desc limit 1;

    perform set_config('udofin.transition_reason', 'routed', true);
    insert into lending.applications (lender_org_id, loan_request_id, borrower_id, product_version_id, requested_amount_minor, requested_tenure_days)
    values (r.lender_org_id, v_req.id, v_borrower, r.product_version_id, v_req.requested_amount_minor, v_req.requested_tenure_days)
    returning id into v_app;
    update lending.applications set status = 'submitted' where id = v_app;
    insert into lending.application_routing (application_id, lender_org_id, loan_request_id, selection_item_id, consent_record_id,
                                             transmission_status, response_due_at, transmitted_at)
    values (v_app, r.lender_org_id, v_req.id, r.id, v_consent,
            case when v_c.kind = 'manual' then 'transmitted' else 'queued' end,
            now() + make_interval(hours => v_c.response_hours),
            case when v_c.kind = 'manual' then now() end);
    perform private.routing_event(v_app, r.lender_org_id, case when v_c.kind = 'manual' then 'available_in_portal' else 'queued' end,
                                  jsonb_build_object('connector_kind', v_c.kind));
    if v_c.kind <> 'manual' then
      -- Only identifiers travel in the job. The contact detail is read when the job runs, after consent is checked again.
      perform ops.enqueue_event('application.routed', jsonb_build_object('application_id', v_app), null, 'route:' || v_app::text);
    end if;
    update lending.lender_selection_items set status = 'routed', consent_record_id = v_consent where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('applicationId', v_app, 'lenderId', r.lender_org_id));
  end loop;
  update lending.lender_selections set status = 'routed', closed_at = now() where id = p_selection;
  perform lending.audit_event('lending.request.routed', 'lender_selection', p_selection::text, jsonb_build_object('count', jsonb_array_length(v_out)));
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Transmission (worker, system only)
-- ---------------------------------------------------------------------------------------------
create or replace function lending.begin_transmission(p_app uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r lending.application_routing;
  v_a lending.applications;
  v_req lending.loan_requests;
  v_b identity.borrowers;
  v_phone text;
  v_kind text;
begin
  if private.invoking_role() <> 'service_role' then raise exception 'system only' using errcode = '42501'; end if;
  select * into v_r from lending.application_routing where application_id = p_app for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  -- A worker that died after starting to send leaves 'transmitting' behind. After five minutes that means the outcome is unknown.
  if v_r.transmission_status = 'transmitting' and v_r.updated_at < now() - interval '5 minutes' then
    update lending.application_routing set transmission_status = 'uncertain', last_error_class = 'worker_interrupted' where application_id = p_app;
    perform private.routing_event(p_app, v_r.lender_org_id, 'uncertain', '{"class":"worker_interrupted"}'::jsonb);
    return jsonb_build_object('skip', 'uncertain');
  end if;
  if v_r.transmission_status <> 'queued' then
    return jsonb_build_object('skip', v_r.transmission_status);
  end if;
  select * into v_a from lending.applications where id = p_app;
  select * into v_req from lending.loan_requests where id = v_a.loan_request_id;
  select * into v_b from identity.borrowers where id = v_a.borrower_id;
  if v_a.status <> 'submitted' or v_b.status <> 'active' then
    update lending.application_routing set transmission_status = 'cancelled' where application_id = p_app;
    perform private.routing_event(p_app, v_r.lender_org_id, 'cancelled_before_send', '{}'::jsonb);
    return jsonb_build_object('skip', 'cancelled');
  end if;
  -- Consent is checked again at the moment of sending, under the same lock a withdrawal needs.
  if not private.lender_consent_ok(v_a.borrower_id, v_r.lender_org_id, v_a.loan_request_id) then
    update lending.application_routing set transmission_status = 'stopped_consent', consent_withdrawn_at = coalesce(consent_withdrawn_at, now()) where application_id = p_app;
    perform private.routing_event(p_app, v_r.lender_org_id, 'stopped_consent', '{"at":"send"}'::jsonb);
    return jsonb_build_object('skip', 'stopped_consent');
  end if;
  select c.kind into v_kind from lending.lender_connectors c where c.lender_org_id = v_r.lender_org_id and c.status = 'active';
  if v_kind is null or v_kind = 'manual' then
    update lending.application_routing set transmission_status = 'failed', last_error_class = 'connector_inactive' where application_id = p_app;
    perform private.routing_event(p_app, v_r.lender_org_id, 'failed', '{"class":"connector_inactive"}'::jsonb);
    return jsonb_build_object('skip', 'failed');
  end if;
  select u.phone into v_phone from auth.users u where u.id = v_b.user_id;
  update lending.application_routing set transmission_status = 'transmitting', attempts = attempts + 1, last_error_class = null where application_id = p_app;
  perform private.routing_event(p_app, v_r.lender_org_id, 'sending', jsonb_build_object('attempt', v_r.attempts + 1));
  -- The approved fixed payload (scope minimum_payload_v1): nothing else is read from the borrower's records.
  return jsonb_build_object(
    'applicationId', p_app, 'lenderId', v_r.lender_org_id, 'connectorKind', v_kind, 'correlationRef', v_r.correlation_ref, 'attempt', v_r.attempts + 1,
    'scope', lending.payload_scope(),
    'payload', jsonb_build_object(
      'udofinReference', v_req.submission_reference,
      'request', jsonb_build_object('categoryKey', v_req.category_key, 'amountMinor', v_req.requested_amount_minor,
                                    'tenureDays', v_req.requested_tenure_days, 'purposeCode', v_req.purpose_code),
      'productVersionId', v_a.product_version_id,
      'displayName', v_b.display_name,
      'phone', v_phone,
      'language', v_b.preferred_language));
end
$$;

create or replace function lending.record_transmission_result(p_app uuid, p_outcome text, p_lender_ref text, p_error_class text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r lending.application_routing;
begin
  if private.invoking_role() <> 'service_role' then raise exception 'system only' using errcode = '42501'; end if;
  if p_outcome not in ('accepted', 'rejected', 'unknown') then raise exception 'invalid outcome' using errcode = '22023'; end if;
  select * into v_r from lending.application_routing where application_id = p_app for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_r.transmission_status <> 'transmitting' then return v_r.transmission_status; end if;
  if p_outcome = 'accepted' then
    update lending.application_routing set transmission_status = case when p_lender_ref is not null then 'acknowledged' else 'transmitted' end,
      transmitted_at = now(), acknowledged_at = case when p_lender_ref is not null then now() end,
      lender_application_ref = left(p_lender_ref, 100)
     where application_id = p_app;
    perform private.routing_event(p_app, v_r.lender_org_id, case when p_lender_ref is not null then 'acknowledged' else 'transmitted' end);
  elsif p_outcome = 'rejected' then
    update lending.application_routing set transmission_status = 'failed', last_error_class = coalesce(nullif(p_error_class, ''), 'rejected') where application_id = p_app;
    perform private.routing_event(p_app, v_r.lender_org_id, 'failed', jsonb_build_object('class', coalesce(nullif(p_error_class, ''), 'rejected')));
  else
    update lending.application_routing set transmission_status = 'uncertain', last_error_class = coalesce(nullif(p_error_class, ''), 'unknown_outcome') where application_id = p_app;
    perform private.routing_event(p_app, v_r.lender_org_id, 'uncertain', jsonb_build_object('class', coalesce(nullif(p_error_class, ''), 'unknown_outcome')));
  end if;
  return (select transmission_status from lending.application_routing where application_id = p_app);
end
$$;

-- After checking with the lender: found -> record it; confirmed absent -> allow one more send; still unknown -> leave uncertain.
create or replace function lending.resolve_uncertain(p_app uuid, p_found text, p_lender_ref text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r lending.application_routing;
begin
  if private.invoking_role() <> 'service_role' then raise exception 'system only' using errcode = '42501'; end if;
  if p_found not in ('found', 'not_found', 'unknown') then raise exception 'invalid result' using errcode = '22023'; end if;
  select * into v_r from lending.application_routing where application_id = p_app for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_r.transmission_status <> 'uncertain' then return v_r.transmission_status; end if;
  if p_found = 'found' then
    update lending.application_routing set transmission_status = case when p_lender_ref is not null then 'acknowledged' else 'transmitted' end,
      transmitted_at = coalesce(transmitted_at, now()), acknowledged_at = case when p_lender_ref is not null then now() end,
      lender_application_ref = left(p_lender_ref, 100), last_error_class = null where application_id = p_app;
    perform private.routing_event(p_app, v_r.lender_org_id, 'reconciled_found');
  elsif p_found = 'not_found' then
    if v_r.attempts >= 5 then
      update lending.application_routing set transmission_status = 'failed', last_error_class = 'attempts_exhausted' where application_id = p_app;
      perform private.routing_event(p_app, v_r.lender_org_id, 'failed', '{"class":"attempts_exhausted"}'::jsonb);
    else
      update lending.application_routing set transmission_status = 'queued' where application_id = p_app;
      perform private.routing_event(p_app, v_r.lender_org_id, 'reconciled_not_found_requeued');
      perform ops.enqueue_event('application.routed', jsonb_build_object('application_id', p_app), null, 'route:' || p_app::text || ':' || (v_r.attempts + 1)::text);
    end if;
  end if;
  return (select transmission_status from lending.application_routing where application_id = p_app);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Lender-reported facts. The same private functions serve manual entry and signed callbacks.
-- ---------------------------------------------------------------------------------------------
create or replace function private.apply_ack(p_app uuid, p_ref text, p_source text, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r lending.application_routing;
begin
  select * into v_r from lending.application_routing where application_id = p_app for update;
  if v_r.transmission_status not in ('transmitted', 'acknowledged') then
    raise exception 'application is not available to the lender' using errcode = '55000', hint = 'invalid_state';
  end if;
  if v_r.lender_application_ref is not null and p_ref is not null and v_r.lender_application_ref <> p_ref then
    raise exception 'a different lender reference is already recorded' using errcode = '55000', hint = 'reference_conflict';
  end if;
  update lending.application_routing set transmission_status = 'acknowledged', acknowledged_at = coalesce(acknowledged_at, now()),
    lender_application_ref = coalesce(lender_application_ref, left(p_ref, 100)) where application_id = p_app;
  if v_r.transmission_status = 'transmitted' then
    perform private.routing_event(p_app, v_r.lender_org_id, 'acknowledged', jsonb_build_object('source', p_source));
  end if;
  return jsonb_build_object('applied', true);
end
$$;

create or replace function private.apply_check(p_app uuid, p_kind text, p_status text, p_ref text, p_reported timestamptz, p_source text, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r lending.application_routing;
begin
  select * into v_r from lending.application_routing where application_id = p_app for update;
  if v_r.transmission_status not in ('transmitted', 'acknowledged') then
    raise exception 'application is not available to the lender' using errcode = '55000', hint = 'invalid_state';
  end if;
  if p_kind not in ('kyc', 'bureau', 'account_aggregator') or p_status not in ('not_started', 'in_progress', 'completed', 'failed') then
    raise exception 'unknown check or status' using errcode = '22023', hint = 'status_unknown';
  end if;
  if p_reported is not null and p_reported > now() + interval '5 minutes' then
    raise exception 'reported time is in the future' using errcode = '22023', hint = 'time_invalid';
  end if;
  insert into lending.application_checks (application_id, lender_org_id, kind, status, source, lender_event_ref, reported_at, recorded_by)
  values (p_app, v_r.lender_org_id, p_kind, p_status, p_source, left(p_ref, 100), coalesce(p_reported, now()), p_user);
  return jsonb_build_object('applied', true);
end
$$;

-- Moves the application along the existing lifecycle. Udofin never decides: it records what the lender reported.
create or replace function private.advance_application(p_app uuid, p_target text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status lending.application_status;
begin
  perform set_config('udofin.transition_reason', p_reason, true);
  select status into v_status from lending.applications where id = p_app for update;
  if p_target = 'under_review' then
    if v_status in ('submitted', 'info_requested') then
      update lending.applications set status = 'under_review' where id = p_app;
    elsif v_status <> 'under_review' then
      raise exception 'invalid state' using errcode = '55000', hint = 'invalid_transition';
    end if;
  elsif p_target in ('info_requested', 'approved') then
    if v_status in ('submitted', 'info_requested') and p_target = 'approved' or v_status = 'submitted' then
      update lending.applications set status = 'under_review' where id = p_app;
      v_status := 'under_review';
    end if;
    if v_status = 'under_review' then
      update lending.applications set status = p_target::lending.application_status where id = p_app;
    elsif v_status::text <> p_target then
      raise exception 'invalid state' using errcode = '55000', hint = 'invalid_transition';
    end if;
  elsif p_target = 'rejected' then
    if v_status = 'info_requested' then
      update lending.applications set status = 'under_review' where id = p_app;
      v_status := 'under_review';
    end if;
    if v_status in ('submitted', 'under_review') then
      update lending.applications set status = 'rejected' where id = p_app;
    elsif v_status <> 'rejected' then
      raise exception 'invalid state' using errcode = '55000', hint = 'invalid_transition';
    end if;
  else
    raise exception 'unknown target' using errcode = '22023';
  end if;
end
$$;
revoke all on function private.advance_application(uuid, text, text) from public;

create or replace function private.apply_decision(p_app uuid, p_decision text, p_ref text, p_reported timestamptz, p_source text, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r lending.application_routing;
  v_late boolean;
  v_target text;
begin
  select * into v_r from lending.application_routing where application_id = p_app for update;
  if v_r.transmission_status not in ('transmitted', 'acknowledged') then
    raise exception 'application is not available to the lender' using errcode = '55000', hint = 'invalid_state';
  end if;
  if p_decision not in ('pending', 'processing', 'info_needed', 'declined', 'approved') then
    raise exception 'unknown decision' using errcode = '22023', hint = 'decision_unknown';
  end if;
  if p_reported is not null and p_reported > now() + interval '5 minutes' then
    raise exception 'reported time is in the future' using errcode = '22023', hint = 'time_invalid';
  end if;
  v_late := v_r.no_response_at is not null;
  if v_late then
    -- No late-response policy exists (D-40). Record it and flag it; apply nothing.
    insert into lending.lender_decisions (application_id, lender_org_id, decision, source, lender_event_ref, reported_at, late, applied, apply_note, recorded_by)
    values (p_app, v_r.lender_org_id, p_decision, p_source, left(p_ref, 100), coalesce(p_reported, now()), true, false, 'late_response_policy_pending', p_user);
    perform private.routing_event(p_app, v_r.lender_org_id, 'late_decision_held', jsonb_build_object('decision', p_decision));
    return jsonb_build_object('applied', false, 'note', 'late_response_policy_pending');
  end if;
  v_target := case p_decision when 'processing' then 'under_review' when 'info_needed' then 'info_requested'
                              when 'declined' then 'rejected' when 'approved' then 'approved' else null end;
  if v_target is not null then
    perform private.advance_application(p_app, v_target, 'lender_' || p_decision);
  end if;
  insert into lending.lender_decisions (application_id, lender_org_id, decision, source, lender_event_ref, reported_at, late, applied, recorded_by)
  values (p_app, v_r.lender_org_id, p_decision, p_source, left(p_ref, 100), coalesce(p_reported, now()), false, true, p_user);
  return jsonb_build_object('applied', true);
end
$$;

-- Validates and stores a lender-issued offer exactly as supplied. Nothing is calculated, rounded or corrected.
create or replace function private.apply_offer(p_app uuid, p_raw jsonb, p_source text, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed text[] := array['lenderOfferRef', 'principalMinor', 'tenureDays', 'installmentFrequency', 'installmentCount', 'installmentAmountMinor',
                            'monthlyRepaymentMinor', 'annualInterestRateBps', 'aprBps', 'processingFeeMinor', 'otherCharges',
                            'totalRepayableMinor', 'penalChargesSummary', 'kfsUrl', 'issuedAt', 'validUntil'];
  v_r lending.application_routing;
  v_a lending.applications;
  v_c lending.lender_connectors;
  v_clean jsonb;
  v_issues text[] := '{}';
  v_principal bigint; v_tenure bigint; v_count bigint; v_inst bigint; v_monthly bigint; v_rate bigint; v_apr bigint; v_fee bigint; v_total bigint;
  v_freq text; v_ref text; v_penal text; v_kfs text; v_kissue text;
  v_issued timestamptz; v_valid timestamptz;
  v_other jsonb;
  v_offer uuid; v_intake uuid; v_rev integer;
begin
  select * into v_r from lending.application_routing where application_id = p_app for update;
  if v_r.transmission_status not in ('transmitted', 'acknowledged') then
    raise exception 'application is not available to the lender' using errcode = '55000', hint = 'invalid_state';
  end if;
  select * into v_a from lending.applications where id = p_app;
  select * into v_c from lending.lender_connectors where lender_org_id = v_a.lender_org_id;
  if jsonb_typeof(p_raw) <> 'object' then raise exception 'offer must be an object' using errcode = '22023', hint = 'offer_invalid'; end if;
  if v_a.status <> 'approved' then
    raise exception 'record the approval first' using errcode = '55000', hint = 'application_not_approved';
  end if;
  if exists (select 1 from lending.offers o where o.application_id = p_app and o.status = 'accepted') then
    raise exception 'an offer was already accepted' using errcode = '55000', hint = 'offer_already_accepted';
  end if;
  -- Keep only approved fields so nothing sensitive can ride along in the stored copy.
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_clean from jsonb_each(p_raw) e(k, v) where k = any (v_allowed);
  if exists (select 1 from jsonb_object_keys(p_raw) k where k <> all (v_allowed)) then v_issues := array_append(v_issues, 'unknown_field'::text); end if;
  if v_r.no_response_at is not null then v_issues := array_append(v_issues, 'late_response_policy_pending'::text); end if;

  v_ref := v_clean ->> 'lenderOfferRef';
  if v_ref is null or v_ref !~ '^[A-Za-z0-9._:-]{1,100}$' then v_issues := array_append(v_issues, 'lender_offer_ref_invalid'::text); end if;
  v_principal := private.jint(v_clean, 'principalMinor');
  if v_principal is null or v_principal <= 0 or v_principal > 100000000000000 then v_issues := array_append(v_issues, 'principal_invalid'::text); end if;
  v_tenure := private.jint(v_clean, 'tenureDays');
  if v_tenure is null or v_tenure not between 1 and 10950 then v_issues := array_append(v_issues, 'tenure_invalid'::text); end if;
  v_freq := v_clean ->> 'installmentFrequency';
  if v_freq is null or v_freq not in ('monthly', 'fortnightly', 'weekly') then v_issues := array_append(v_issues, 'installment_frequency_invalid'::text); end if;
  v_count := private.jint(v_clean, 'installmentCount');
  if v_count is null or v_count not between 1 and 1200 then v_issues := array_append(v_issues, 'installment_count_invalid'::text); end if;
  v_inst := private.jint(v_clean, 'installmentAmountMinor');
  if v_inst is null or v_inst <= 0 or v_inst > 100000000000000 then v_issues := array_append(v_issues, 'installment_amount_invalid'::text); end if;
  v_monthly := private.jint(v_clean, 'monthlyRepaymentMinor');
  if v_monthly is null or v_monthly <= 0 or v_monthly > 100000000000000 then v_issues := array_append(v_issues, 'monthly_repayment_missing'::text);
  elsif v_freq = 'monthly' and v_inst is not null and v_monthly <> v_inst then v_issues := array_append(v_issues, 'monthly_repayment_inconsistent'::text); end if;
  v_rate := private.jint(v_clean, 'annualInterestRateBps');
  if v_rate is null or v_rate not between 0 and 10000 then v_issues := array_append(v_issues, 'interest_rate_invalid'::text); end if;
  v_apr := private.jint(v_clean, 'aprBps');
  if v_apr is null or v_apr not between 0 and 20000 then v_issues := array_append(v_issues, 'apr_invalid'::text); end if;
  v_fee := private.jint(v_clean, 'processingFeeMinor');
  if v_fee is null or v_fee < 0 or v_fee > 100000000000000 then v_issues := array_append(v_issues, 'processing_fee_invalid'::text); end if;
  v_total := private.jint(v_clean, 'totalRepayableMinor');
  if v_total is null or v_total > 100000000000000 or (v_principal is not null and v_total < v_principal) then v_issues := array_append(v_issues, 'total_repayable_invalid'::text); end if;
  v_penal := v_clean ->> 'penalChargesSummary';
  if v_penal is null or length(trim(v_penal)) not between 1 and 2000 or jsonb_typeof(v_clean -> 'penalChargesSummary') <> 'string' then v_issues := array_append(v_issues, 'penal_charges_missing'::text); end if;
  v_other := coalesce(v_clean -> 'otherCharges', '[]'::jsonb);
  if jsonb_typeof(v_other) <> 'array' or jsonb_array_length(v_other) > 20 or length(v_other::text) > 4000 then v_issues := array_append(v_issues, 'other_charges_invalid'::text); v_other := '[]'::jsonb; end if;
  v_kfs := v_clean ->> 'kfsUrl';
  v_kissue := private.kfs_issue(v_kfs, v_c.kfs_allowed_hosts);
  if v_kissue is not null then v_issues := array_append(v_issues, v_kissue); end if;
  v_issued := private.try_timestamptz(v_clean ->> 'issuedAt');
  v_valid := private.try_timestamptz(v_clean ->> 'validUntil');
  if v_issued is null or v_issued > now() + interval '5 minutes' then v_issues := array_append(v_issues, 'issued_at_invalid'::text); end if;
  if v_valid is null or v_valid <= now() then v_issues := array_append(v_issues, 'valid_until_invalid'::text);
  elsif v_issued is not null and v_valid - v_issued < make_interval(days => v_c.offer_min_validity_days) then v_issues := array_append(v_issues, 'validity_too_short'::text); end if;

  if cardinality(v_issues) = 0 then
    update lending.offers set status = 'withdrawn' where application_id = p_app and status = 'issued';
    select coalesce(max(revision), 0) + 1 into v_rev from lending.offers where application_id = p_app and lender_offer_ref = v_ref;
    insert into lending.offers (lender_org_id, application_id, status, principal_minor, tenure_days, installment_frequency, installment_count,
                                installment_amount_minor, annual_interest_rate_bps, apr_bps, processing_fee_minor, other_charges, total_repayable_minor,
                                penal_charges_summary, valid_until, issued_at, created_by, monthly_repayment_minor, kfs_url, lender_offer_ref,
                                revision, supersedes_offer_id, lender_issued_at, source)
    values (v_a.lender_org_id, p_app, 'issued', v_principal, v_tenure, v_freq::lending.installment_frequency, v_count, v_inst, v_rate, v_apr, v_fee, v_other,
            v_total, v_penal, v_valid, now(), p_user, v_monthly, v_kfs, v_ref, v_rev,
            (select o.id from lending.offers o where o.application_id = p_app order by o.issued_at desc, o.id desc limit 1), v_issued, p_source)
    returning id into v_offer;
  end if;
  insert into lending.offer_intake (application_id, lender_org_id, submitted, validation, issues, offer_id, source, submitted_by)
  values (p_app, v_a.lender_org_id, v_clean, case when cardinality(v_issues) = 0 then 'accepted' else 'held' end, v_issues, v_offer, p_source, p_user)
  returning id into v_intake;
  perform private.routing_event(p_app, v_a.lender_org_id, case when v_offer is null then 'offer_held' else 'offer_received' end,
                                jsonb_build_object('issues', v_issues));
  return jsonb_build_object('applied', v_offer is not null, 'status', case when v_offer is null then 'held' else 'accepted' end,
                            'issues', to_jsonb(v_issues), 'offerId', v_offer, 'intakeId', v_intake,
                            'note', case when 'late_response_policy_pending' = any (v_issues) then 'late_response_policy_pending' end);
end
$$;

create or replace function private.apply_offer_withdrawn(p_app uuid, p_ref text, p_source text, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r lending.application_routing;
  v_offer uuid;
begin
  select * into v_r from lending.application_routing where application_id = p_app for update;
  select o.id into v_offer from lending.offers o where o.application_id = p_app and o.lender_offer_ref = p_ref and o.status = 'issued'
    order by o.revision desc limit 1;
  if v_offer is null then raise exception 'no open offer with that reference' using errcode = 'P0002', hint = 'offer_not_found'; end if;
  update lending.offers set status = 'withdrawn' where id = v_offer;
  perform private.routing_event(p_app, v_r.lender_org_id, 'offer_withdrawn', jsonb_build_object('source', p_source));
  return jsonb_build_object('applied', true, 'offerId', v_offer);
end
$$;
revoke all on function private.apply_ack(uuid, text, text, uuid), private.apply_check(uuid, text, text, text, timestamptz, text, uuid),
  private.apply_decision(uuid, text, text, timestamptz, text, uuid), private.apply_offer(uuid, jsonb, text, uuid),
  private.apply_offer_withdrawn(uuid, text, text, uuid) from public;

-- ---------------------------------------------------------------------------------------------
-- Manual processing in the lender portal (the same rules as callbacks; the actor is a signed-in lender user)
-- ---------------------------------------------------------------------------------------------
create or replace function private.assert_lender_decide(p_app uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lender uuid;
begin
  select lender_org_id into v_lender from lending.application_routing where application_id = p_app;
  if v_lender is null or v_lender not in (select private.orgs_with_permission('application.read')) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if v_lender not in (select private.orgs_with_permission('application.decide')) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
end
$$;
revoke all on function private.assert_lender_decide(uuid) from public;

create or replace function lending.lender_ack_application(p_app uuid, p_lender_ref text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_lender_decide(p_app);
  perform private.apply_ack(p_app, p_lender_ref, 'manual', (select auth.uid()));
  perform lending.audit_event('lending.application.acknowledged', 'application', p_app::text);
end
$$;

create or replace function lending.lender_report_check(p_app uuid, p_kind text, p_status text, p_ref text, p_reported timestamptz)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_lender_decide(p_app);
  perform private.apply_check(p_app, p_kind, p_status, p_ref, p_reported, 'manual', (select auth.uid()));
  perform lending.audit_event('lending.check.reported', 'application', p_app::text, jsonb_build_object('kind', p_kind, 'status', p_status));
end
$$;

create or replace function lending.lender_record_decision(p_app uuid, p_decision text, p_ref text, p_reported timestamptz)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.assert_lender_decide(p_app);
  v := private.apply_decision(p_app, p_decision, p_ref, p_reported, 'manual', (select auth.uid()));
  perform lending.audit_event('lending.decision.recorded', 'application', p_app::text, jsonb_build_object('decision', p_decision, 'applied', v -> 'applied'));
  return v;
end
$$;

create or replace function lending.lender_submit_offer(p_app uuid, p_offer jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.assert_lender_decide(p_app);
  v := private.apply_offer(p_app, p_offer, 'manual', (select auth.uid()));
  perform lending.audit_event('lending.offer.submitted', 'application', p_app::text, jsonb_build_object('status', v -> 'status'));
  return v;
end
$$;

create or replace function lending.lender_withdraw_offer(p_app uuid, p_offer_ref text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  perform private.assert_lender_decide(p_app);
  v := private.apply_offer_withdrawn(p_app, p_offer_ref, 'manual', (select auth.uid()));
  perform lending.audit_event('lending.offer.withdrawn', 'application', p_app::text);
  return v;
end
$$;

-- The borrower's phone number for a lender that works manually. Read at the moment of the call, never stored, and refused
-- unless consent is in force. The audit entry names the application only.
create or replace function lending.lender_contact(p_app uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_r lending.application_routing;
  v_a lending.applications;
  v_b identity.borrowers;
  v_phone text;
begin
  perform private.assert_lender_decide(p_app);
  select * into v_r from lending.application_routing where application_id = p_app;
  select * into v_a from lending.applications where id = p_app;
  if v_r.transmission_status not in ('transmitted', 'acknowledged') or v_r.consent_withdrawn_at is not null
     or not private.lender_consent_ok(v_a.borrower_id, v_a.lender_org_id, v_a.loan_request_id) then
    raise exception 'consent is not in force' using errcode = '55000', hint = 'consent_required';
  end if;
  select * into v_b from identity.borrowers where id = v_a.borrower_id;
  select u.phone into v_phone from auth.users u where u.id = v_b.user_id;
  perform lending.audit_event('lending.contact.disclosed', 'application', p_app::text);
  return jsonb_build_object('phone', v_phone);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Signed callbacks (system only; the API has already verified the signature). One record per message id.
-- ---------------------------------------------------------------------------------------------
create or replace function lending.lender_hook_context(p_lender uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when private.invoking_role() = 'service_role'
         then (select jsonb_build_object('kind', c.kind, 'status', c.status, 'signingSecretRef', c.signing_secret_ref)
                 from lending.lender_connectors c where c.lender_org_id = p_lender)
         else null end
$$;

create or replace function lending.ingest_lender_event(p_lender uuid, p_message_id text, p_type text, p_correlation uuid, p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg uuid;
  v_r lending.application_routing;
  v_res jsonb;
  v_hint text;
  v_state text;
begin
  if private.invoking_role() <> 'service_role' then raise exception 'system only' using errcode = '42501'; end if;
  insert into lending.inbound_messages (lender_org_id, message_id, event_type) values (p_lender, p_message_id, left(p_type, 40))
  on conflict (lender_org_id, message_id) do nothing returning id into v_msg;
  if v_msg is null then return jsonb_build_object('outcome', 'duplicate'); end if;
  if p_type not in ('ack', 'check', 'decision', 'offer', 'offer_withdrawn') then
    update lending.inbound_messages set outcome = 'quarantined', reason_class = 'unknown_event_type' where id = v_msg;
    return jsonb_build_object('outcome', 'quarantined', 'reason', 'unknown_event_type');
  end if;
  select * into v_r from lending.application_routing where correlation_ref = p_correlation and lender_org_id = p_lender;
  if not found then
    update lending.inbound_messages set outcome = 'rejected', reason_class = 'unknown_application' where id = v_msg;
    return jsonb_build_object('outcome', 'rejected', 'reason', 'unknown_application');
  end if;
  begin
    v_res := case p_type
      when 'ack' then private.apply_ack(v_r.application_id, p_body ->> 'lenderApplicationRef', 'connector', null)
      when 'check' then private.apply_check(v_r.application_id, p_body ->> 'kind', p_body ->> 'status', p_body ->> 'lenderEventRef',
                                            private.try_timestamptz(p_body ->> 'reportedAt'), 'connector', null)
      when 'decision' then private.apply_decision(v_r.application_id, p_body ->> 'decision', p_body ->> 'lenderEventRef',
                                                  private.try_timestamptz(p_body ->> 'reportedAt'), 'connector', null)
      when 'offer' then private.apply_offer(v_r.application_id, p_body -> 'offer', 'connector', null)
      when 'offer_withdrawn' then private.apply_offer_withdrawn(v_r.application_id, p_body ->> 'lenderOfferRef', 'connector', null)
    end;
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint, v_state = returned_sqlstate;
    update lending.inbound_messages set outcome = 'rejected',
      reason_class = case when v_hint ~ '^[a-z_]{2,50}$' then v_hint else 'invalid_event' end where id = v_msg;
    return jsonb_build_object('outcome', 'rejected', 'reason', case when v_hint ~ '^[a-z_]{2,50}$' then v_hint else 'invalid_event' end);
  end;
  -- Quarantined only when something was set aside on purpose (a late answer awaiting policy). A held offer WAS processed:
  -- it is stored, shown to the lender as needing correction, and the result carries the issues.
  update lending.inbound_messages set outcome = case when v_res ->> 'note' is not null then 'quarantined' else 'applied' end,
    reason_class = coalesce(v_res ->> 'note', case when v_res ->> 'status' = 'held' then 'offer_held' end) where id = v_msg;
  perform lending.audit_event('lending.callback.processed', 'application', v_r.application_id::text, jsonb_build_object('type', p_type, 'applied', v_res -> 'applied'));
  return jsonb_build_object('outcome', case when v_res ->> 'note' is not null then 'quarantined' else 'applied' end, 'result', v_res);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Housekeeping (worker): deadlines and offer expiry. Never decides anything for a lender.
-- ---------------------------------------------------------------------------------------------
create or replace function lending.process_deadlines()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nr integer := 0;
  v_exp integer;
  r record;
begin
  if private.invoking_role() <> 'service_role' then raise exception 'system only' using errcode = '42501'; end if;
  for r in select ar.application_id, ar.lender_org_id from lending.application_routing ar
            join lending.applications a on a.id = ar.application_id
           where ar.no_response_at is null and ar.response_due_at < now() and ar.transmission_status in ('transmitted', 'acknowledged')
             and a.status in ('submitted', 'under_review', 'info_requested')
           for update of ar skip locked loop
    update lending.application_routing set no_response_at = now() where application_id = r.application_id and no_response_at is null;
    perform private.routing_event(r.application_id, r.lender_org_id, 'no_response_by_deadline');
    v_nr := v_nr + 1;
  end loop;
  with e as (update lending.offers set status = 'expired' where status = 'issued' and valid_until < now() returning id)
  select count(*) into v_exp from e;
  return jsonb_build_object('noResponse', v_nr, 'offersExpired', v_exp);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Borrower reads and actions
-- ---------------------------------------------------------------------------------------------
create or replace function private.application_stage(p_app_status text, p_tx text, p_no_response boolean, p_has_offer boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_app_status = 'withdrawn' then 'withdrawn'
    when p_tx in ('stopped_consent', 'cancelled') then 'stopped'
    when p_tx in ('failed', 'uncertain') then 'technical_failure'
    when p_app_status = 'rejected' then 'declined'
    when p_has_offer then 'offer_received'
    when p_app_status = 'approved' then 'approved_awaiting_offer'
    when p_no_response then 'no_response'
    when p_tx in ('queued', 'transmitting') then 'sending'
    when p_app_status = 'info_requested' then 'info_requested'
    when p_app_status = 'under_review' then 'processing'
    when p_tx = 'acknowledged' then 'acknowledged'
    else 'sent'
  end
$$;

create or replace function lending.my_applications(p_request uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
begin
  if not exists (select 1 from lending.loan_requests r where r.id = p_request and r.borrower_id = v_borrower) then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'applicationId', a.id, 'lenderId', a.lender_org_id, 'lenderName', o.display_name, 'productName', p.name,
      'status', a.status, 'transmission', ar.transmission_status, 'responseDueAt', ar.response_due_at,
      'stage', private.application_stage(a.status::text, ar.transmission_status, ar.no_response_at is not null,
                                         exists (select 1 from lending.offers x where x.application_id = a.id and x.status = 'issued' and x.valid_until > now() and x.kfs_url is not null)),
      'checks', coalesce((select jsonb_agg(jsonb_build_object('kind', c.kind, 'status', c.status, 'reportedAt', c.reported_at) order by c.kind)
                            from lending.application_check_status c where c.application_id = a.id), '[]'::jsonb),
      'consentWithdrawn', ar.consent_withdrawn_at is not null,
      'createdAt', a.created_at) order by a.created_at, a.id)
    from lending.applications a
    join lending.application_routing ar on ar.application_id = a.id
    join tenancy.organizations o on o.id = a.lender_org_id
    join lending.loan_product_versions v on v.id = a.product_version_id
    join lending.loan_products p on p.id = v.product_id
    where a.loan_request_id = p_request and a.borrower_id = v_borrower), '[]'::jsonb);
end
$$;

create or replace function lending.withdraw_application(p_app uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_a lending.applications;
  v_r lending.application_routing;
begin
  select * into v_r from lending.application_routing where application_id = p_app for update;
  select * into v_a from lending.applications where id = p_app and borrower_id = v_borrower;
  if v_a.id is null or v_r.application_id is null then raise exception 'not found' using errcode = 'P0002'; end if;
  perform set_config('udofin.transition_reason', 'withdrawn_by_borrower', true);
  update lending.applications set status = 'withdrawn' where id = p_app;
  if v_r.transmission_status in ('queued', 'uncertain') then
    update lending.application_routing set transmission_status = 'cancelled' where application_id = p_app;
  end if;
  update lending.offers set status = 'declined' where application_id = p_app and status = 'issued';
  perform private.routing_event(p_app, v_a.lender_org_id, 'withdrawn_by_borrower');
  perform lending.audit_event('lending.application.withdrawn', 'application', p_app::text);
end
$$;

-- Offers that can be shown: current, unexpired, with a KFS link and a lender-supplied monthly repayment, from a lender that
-- still holds the borrower's consent. Nothing here is calculated.
create or replace function private.eligible_offers(p_request uuid, p_borrower uuid)
returns table (offer_id uuid, application_id uuid, lender_org_id uuid, apr_bps integer, monthly bigint, total bigint, revision integer)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.application_id, o.lender_org_id, o.apr_bps, o.monthly_repayment_minor, o.total_repayable_minor, o.revision
  from lending.offers o
  join lending.applications a on a.id = o.application_id
  join lending.application_routing ar on ar.application_id = a.id
  where a.loan_request_id = p_request and a.borrower_id = p_borrower and a.status = 'approved'
    and o.status = 'issued' and o.valid_until > now() and o.kfs_url is not null and o.monthly_repayment_minor is not null
    and ar.consent_withdrawn_at is null and ar.transmission_status in ('transmitted', 'acknowledged')
$$;
revoke all on function private.eligible_offers(uuid, uuid) from public;

-- The comparison. Serving it writes the display log in the same transaction: what was shown, in what order, under which rule.
create or replace function lending.compare_offers(p_request uuid, p_sort text, p_platform text, p_language text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_rule lending.matching_rule_versions;
  v_keys text[];
  v_run uuid;
  v_ios boolean := false;
  v_filtered integer := 0;
  v_offers jsonb;
  v_non jsonb;
begin
  if not exists (select 1 from lending.loan_requests r where r.id = p_request and r.borrower_id = v_borrower) then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if p_platform not in ('android', 'ios', 'web') or p_language not in ('en', 'hi') then
    raise exception 'invalid parameters' using errcode = '22023';
  end if;
  v_rule := lending.rule_in_force();
  if v_rule.id is null then
    raise exception 'no approved ordering rule is in force' using errcode = '55000', hint = 'ranking_rule_not_approved';
  end if;
  if p_sort is null then
    v_keys := v_rule.sort_keys;
  else
    if not (p_sort = any (v_rule.alternative_sorts) or p_sort = v_rule.sort_keys[1]) then
      raise exception 'that sort is not offered' using errcode = '22023', hint = 'sort_unsupported';
    end if;
    v_keys := case when p_sort = v_rule.sort_keys[1] then v_rule.sort_keys else array[p_sort, v_rule.sort_keys[1]] end;
  end if;
  v_ios := p_platform = 'ios' and coalesce((select s.bool_value from onboarding.platform_settings s where s.key = 'ios_apr_filter_enabled'), false);

  if v_ios then
    select count(*) into v_filtered from private.eligible_offers(p_request, v_borrower) where apr_bps > 3600;
  end if;

  insert into lending.comparison_runs (borrower_id, loan_request_id, rule_version_id, sort_key, platform, ios_filter_applied, filtered_count, language)
  values (v_borrower, p_request, v_rule.id, array_to_string(v_keys, '>'), p_platform, v_ios, v_filtered, p_language)
  returning id into v_run;
  insert into lending.offer_displays (lender_org_id, offer_id, borrower_id, rank_position, rule_version_id, run_id, offer_revision)
  select e.lender_org_id, e.offer_id, v_borrower,
         (row_number() over (order by
            case v_keys[1] when 'apr_bps' then e.apr_bps::bigint when 'monthly_repayment_minor' then e.monthly else e.total end,
            case coalesce(v_keys[2], '') when 'apr_bps' then e.apr_bps::bigint when 'monthly_repayment_minor' then e.monthly when 'total_repayable_minor' then e.total else 0 end,
            e.offer_id))::integer,
         v_rule.id, v_run, e.revision
  from private.eligible_offers(p_request, v_borrower) e
  where not (v_ios and e.apr_bps > 3600);

  select coalesce(jsonb_agg(jsonb_build_object(
      'offerId', o.id, 'applicationId', o.application_id, 'lenderId', o.lender_org_id, 'lenderName', org.display_name, 'productName', p.name,
      'rank', d.rank_position, 'principalMinor', o.principal_minor, 'tenureDays', o.tenure_days, 'aprBps', o.apr_bps,
      'monthlyRepaymentMinor', o.monthly_repayment_minor, 'penalChargesSummary', o.penal_charges_summary, 'kfsUrl', o.kfs_url,
      'validUntil', o.valid_until, 'revision', o.revision, 'revised', o.supersedes_offer_id is not null) order by d.rank_position), '[]'::jsonb)
  into v_offers
  from lending.offer_displays d
  join lending.offers o on o.id = d.offer_id
  join tenancy.organizations org on org.id = o.lender_org_id
  join lending.applications a on a.id = o.application_id
  join lending.loan_product_versions v on v.id = a.product_version_id
  join lending.loan_products p on p.id = v.product_id
  where d.run_id = v_run;

  -- Lenders the borrower chose that produced no displayable offer, each with a truthful class (never "declined" by default).
  insert into lending.comparison_nonoffers (run_id, lender_org_id, application_id, reason_class)
  select v_run, k.lender_org_id, k.id, k.reason_class from (
    select a.id, a.lender_org_id,
           private.application_stage(a.status::text, ar.transmission_status, ar.no_response_at is not null, false) as stage,
           case private.application_stage(a.status::text, ar.transmission_status, ar.no_response_at is not null, false)
             when 'declined' then 'declined'
             when 'no_response' then 'no_response'
             when 'technical_failure' then 'technical_failure'
             when 'approved_awaiting_offer' then case when exists (select 1 from lending.offers x where x.application_id = a.id)
                                                      or exists (select 1 from lending.offer_intake i where i.application_id = a.id)
                                                 then 'offer_unavailable' else 'processing' end
             else 'processing' end as reason_class
    from lending.applications a
    join lending.application_routing ar on ar.application_id = a.id
    where a.loan_request_id = p_request and a.borrower_id = v_borrower and ar.consent_withdrawn_at is null
      and not exists (select 1 from private.eligible_offers(p_request, v_borrower) e where e.application_id = a.id and not (v_ios and e.apr_bps > 3600))
      and not (v_ios and exists (select 1 from lending.offers x where x.application_id = a.id and x.status = 'issued' and x.valid_until > now() and x.apr_bps > 3600))
  ) k where k.stage not in ('withdrawn', 'stopped');
  select coalesce(jsonb_agg(jsonb_build_object('lenderId', n.lender_org_id, 'lenderName', org.display_name, 'applicationId', n.application_id, 'reason', n.reason_class)
                            order by org.display_name, n.application_id), '[]'::jsonb)
  into v_non
  from lending.comparison_nonoffers n join tenancy.organizations org on org.id = n.lender_org_id where n.run_id = v_run;

  perform lending.audit_event('lending.comparison.viewed', 'comparison_run', v_run::text,
    jsonb_build_object('rule_version', v_rule.version, 'sort', array_to_string(v_keys, '>'), 'offers', jsonb_array_length(v_offers), 'platform', p_platform));
  return jsonb_build_object('runId', v_run,
    'rule', jsonb_build_object('version', v_rule.version, 'metric', v_rule.disclosed_metric, 'summary', v_rule.mechanism_summary,
                               'defaultSort', v_rule.sort_keys, 'alternativeSorts', v_rule.alternative_sorts),
    'sort', array_to_string(v_keys, '>'), 'offers', v_offers, 'nonOffers', v_non, 'filteredCount', v_filtered);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Lender queue and detail (approved payload only; no borrower id, no phone)
-- ---------------------------------------------------------------------------------------------
create or replace function lending.lender_applications(p_limit integer, p_before timestamptz, p_before_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then raise exception 'invalid limit' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(row_json order by created_at desc, id desc) from (
      select a.created_at, a.id, jsonb_build_object(
        'applicationId', a.id, 'udofinReference', lr.submission_reference, 'status', a.status, 'transmission', ar.transmission_status,
        'responseDueAt', ar.response_due_at, 'noResponseAt', ar.no_response_at, 'lenderApplicationRef', ar.lender_application_ref,
        'request', jsonb_build_object('categoryKey', lr.category_key, 'amountMinor', lr.requested_amount_minor,
                                      'tenureDays', lr.requested_tenure_days, 'purposeCode', lr.purpose_code),
        'productName', p.name, 'displayName', b.display_name, 'language', b.preferred_language,
        'consentWithdrawn', ar.consent_withdrawn_at is not null,
        'checks', coalesce((select jsonb_agg(jsonb_build_object('kind', c.kind, 'status', c.status, 'reportedAt', c.reported_at) order by c.kind)
                              from lending.application_check_status c where c.application_id = a.id), '[]'::jsonb),
        'offer', (select jsonb_build_object('offerId', x.id, 'status', x.status, 'validUntil', x.valid_until, 'revision', x.revision)
                    from lending.offers x where x.application_id = a.id order by x.issued_at desc, x.id desc limit 1),
        'createdAt', a.created_at) as row_json
      from lending.applications a
      join lending.application_routing ar on ar.application_id = a.id
      join lending.loan_requests lr on lr.id = a.loan_request_id
      join identity.borrowers b on b.id = a.borrower_id
      join lending.loan_product_versions v on v.id = a.product_version_id
      join lending.loan_products p on p.id = v.product_id
      where a.lender_org_id in (select private.orgs_with_permission('application.read'))
        and ar.transmission_status in ('transmitted', 'acknowledged')
        and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
      order by a.created_at desc, a.id desc limit p_limit) q), '[]'::jsonb);
end
$$;

create or replace function lending.lender_application_detail(p_app uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lender uuid;
begin
  select lender_org_id into v_lender from lending.application_routing where application_id = p_app and transmission_status in ('transmitted', 'acknowledged');
  if v_lender is null or v_lender not in (select private.orgs_with_permission('application.read')) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'decisions', coalesce((select jsonb_agg(jsonb_build_object('decision', d.decision, 'source', d.source, 'reportedAt', d.reported_at, 'late', d.late,
                                                                'applied', d.applied, 'note', d.apply_note, 'recordedAt', d.recorded_at) order by d.recorded_at desc)
                             from lending.lender_decisions d where d.application_id = p_app), '[]'::jsonb),
    'offerIntake', coalesce((select jsonb_agg(jsonb_build_object('intakeId', i.id, 'validation', i.validation, 'issues', i.issues, 'offerId', i.offer_id,
                                                                  'submittedAt', i.submitted_at, 'submitted', i.submitted) order by i.submitted_at desc)
                               from lending.offer_intake i where i.application_id = p_app), '[]'::jsonb),
    'offers', coalesce((select jsonb_agg(jsonb_build_object('offerId', o.id, 'status', o.status, 'revision', o.revision, 'lenderOfferRef', o.lender_offer_ref,
                                                             'validUntil', o.valid_until, 'kfsUrl', o.kfs_url, 'aprBps', o.apr_bps) order by o.issued_at desc)
                          from lending.offers o where o.application_id = p_app), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'occurredAt', e.occurred_at) order by e.occurred_at)
                          from lending.routing_events e where e.application_id = p_app), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants: borrower and lender functions need EXECUTE for signed-in users (each checks who is calling); the system ones only service_role.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'lending.set_lender_connector(uuid, text, text, integer, integer, text[], text)',
    'lending.propose_matching_rule(text, text, text[], text[], timestamptz)', 'lending.decide_matching_rule(uuid, boolean)',
    'lending.matching_products(uuid)', 'lending.select_lenders(uuid, jsonb)',
    'consent.record_lender_decision(uuid, uuid, uuid, consent.decision, text, text)', 'lending.remove_selection_item(uuid, uuid)',
    'lending.route_selection(uuid)', 'lending.my_applications(uuid)', 'lending.withdraw_application(uuid)',
    'lending.compare_offers(uuid, text, text, text)',
    'lending.lender_ack_application(uuid, text)', 'lending.lender_report_check(uuid, text, text, text, timestamptz)',
    'lending.lender_record_decision(uuid, text, text, timestamptz)', 'lending.lender_submit_offer(uuid, jsonb)',
    'lending.lender_withdraw_offer(uuid, text)', 'lending.lender_contact(uuid)',
    'lending.lender_applications(integer, timestamptz, uuid)', 'lending.lender_application_detail(uuid)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    'lending.begin_transmission(uuid)', 'lending.record_transmission_result(uuid, text, text, text)', 'lending.resolve_uncertain(uuid, text, text)',
    'lending.lender_hook_context(uuid)', 'lending.ingest_lender_event(uuid, text, text, uuid, jsonb)', 'lending.process_deadlines()']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;
