-- =============================================================================================
-- Phase 04 (owner decision D-33): an optional, controlled waiver of the verified accounting record.
--
-- The default stays strict: production readiness needs a verified accounting framework / Ind AS
-- record. A compliance officer may switch on a platform setting that allows a per-lender waiver;
-- each waiver is requested with a written reason by one person, approved by another, can be
-- revoked, and counts only while the setting stays on. Everything is audited.
-- =============================================================================================

create table onboarding.platform_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{2,60}$'),
  bool_value boolean not null,
  description text not null,
  reason text check (reason is null or length(reason) <= 1000),
  changed_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);
comment on table onboarding.platform_settings is 'Compliance-controlled switches for onboarding policy. Owner: onboarding module.';
insert into onboarding.platform_settings (key, bool_value, description) values
  ('accounting_waiver_allowed', false,
   'When true, an independently approved waiver can stand in for a verified accounting framework / Ind AS record at production readiness.');

create table onboarding.accounting_waivers (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  reason text not null check (length(reason) between 30 and 2000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'revoked')),
  requested_by uuid not null references auth.users (id),
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  updated_at timestamptz not null default now(),
  constraint waiver_independent check (decided_by is null or decided_by <> requested_by)
);
create unique index accounting_waivers_one_open on onboarding.accounting_waivers (lender_org_id) where status in ('pending', 'approved');
comment on table onboarding.accounting_waivers is 'Per-lender waiver of the verified accounting record; only usable while the platform setting allows it. Owner: onboarding module.';

do $$
declare
  t text;
begin
  foreach t in array array['platform_settings', 'accounting_waivers'] loop
    execute format('alter table onboarding.%I enable row level security', t);
    execute format('alter table onboarding.%I force row level security', t);
    execute format('create trigger audit_row after insert or update on onboarding.%I for each row execute function onboarding.audit_row()', t);
    execute format('create trigger no_delete before delete on onboarding.%I for each row execute function private.forbid_mutation()', t);
    execute format('create trigger no_truncate before truncate on onboarding.%I for each statement execute function private.forbid_truncate()', t);
    execute format('create trigger set_updated_at before update on onboarding.%I for each row execute function private.set_updated_at()', t);
  end loop;
end
$$;
create trigger unsafe_text before insert or update on onboarding.accounting_waivers
  for each row execute function onboarding.reject_unsafe_text('reason', 'decision_note');
create trigger unsafe_text before insert or update on onboarding.platform_settings
  for each row execute function onboarding.reject_unsafe_text('reason');

create policy tenant_read on onboarding.accounting_waivers for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('onboarding.read')));
create policy staff_read on onboarding.platform_settings for select to authenticated
  using (exists (select 1 from private.orgs_with_permission('onboarding.read')) or (select private.has_platform_permission('onboarding.read')));
grant select on onboarding.accounting_waivers, onboarding.platform_settings to authenticated;

create or replace function onboarding.set_setting(p_key text, p_value boolean, p_reason text)
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
  if p_reason is null or length(trim(p_reason)) < 20 then
    raise exception 'record why the setting is being changed' using errcode = '22023';
  end if;
  update onboarding.platform_settings set bool_value = p_value, reason = p_reason, changed_by = (select auth.uid()) where key = p_key;
  if not found then
    raise exception 'setting not found' using errcode = 'P0002';
  end if;
end
$$;

create or replace function onboarding.waiver_request(p_lender uuid, p_reason text)
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
  if not coalesce((select bool_value from onboarding.platform_settings where key = 'accounting_waiver_allowed'), false) then
    raise exception 'waiving the accounting record is not enabled' using errcode = '55000', hint = 'waiver_not_allowed';
  end if;
  insert into onboarding.accounting_waivers (lender_org_id, reason, requested_by) values (p_lender, p_reason, (select auth.uid()))
  returning id into v_id;
  return v_id;
end
$$;

create or replace function onboarding.waiver_decide(p_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row onboarding.accounting_waivers;
begin
  perform private.ob_require_approve();
  select * into v_row from onboarding.accounting_waivers where id = p_id for update;
  if not found then
    raise exception 'waiver not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'waiver is %, not pending', v_row.status using errcode = '55000';
  end if;
  if v_row.requested_by = (select auth.uid()) then
    raise exception 'the requester cannot decide the waiver' using errcode = '42501', hint = 'self_approval';
  end if;
  if p_approve and not coalesce((select bool_value from onboarding.platform_settings where key = 'accounting_waiver_allowed'), false) then
    raise exception 'waiving the accounting record is not enabled' using errcode = '55000', hint = 'waiver_not_allowed';
  end if;
  update onboarding.accounting_waivers set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = (select auth.uid()), decided_at = now(), decision_note = p_note where id = p_id;
end
$$;

create or replace function onboarding.waiver_revoke(p_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.ob_require_approve();
  if p_note is null or length(trim(p_note)) < 10 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  update onboarding.accounting_waivers set status = 'revoked', decision_note = p_note where id = p_id and status = 'approved';
  if not found then
    raise exception 'approved waiver not found' using errcode = 'P0002';
  end if;
end
$$;

revoke all on function onboarding.set_setting(text, boolean, text), onboarding.waiver_request(uuid, text),
  onboarding.waiver_decide(uuid, boolean, text), onboarding.waiver_revoke(uuid, text) from public;
grant execute on function onboarding.set_setting(text, boolean, text), onboarding.waiver_request(uuid, text),
  onboarding.waiver_decide(uuid, boolean, text), onboarding.waiver_revoke(uuid, text) to authenticated;

-- gate_conditions: the accounting condition also accepts an approved waiver while the setting is on.
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
  c_accounting_ver := exists (select 1 from onboarding.accounting_profiles a where a.lender_org_id = p_lender and a.status = 'verified')
    or (coalesce((select s.bool_value from onboarding.platform_settings s where s.key = 'accounting_waiver_allowed'), false)
        and exists (select 1 from onboarding.accounting_waivers w where w.lender_org_id = p_lender and w.status = 'approved'));
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
    ('accounting_profile_verified', c_accounting_ver, 'the accounting framework / Ind AS status has been verified with evidence (or an approved waiver is in force)', array['production_ready_approved', 'activated']),
    ('category_activation_allowed', c_category, 'compliance has signed off the lender''s institution category', array['production_ready_approved', 'activated']),
    ('institution_verification_current', c_current, 'institution verification and licence are still current', array['production_ready_approved', 'activated']),
    ('verified_contract_current', c_contract, 'the verified contract is still in force', array['production_ready_approved', 'activated']),
    ('service_scope_in_force', c_scope, 'an agreed or active service scope exists', array['production_ready_approved']),
    ('service_active', c_service_active, 'at least one service version has been activated', array['activated'])
  ) as x (key, ok, detail, targets)
  where p_target = any (x.targets);
end
$$;

revoke all on function onboarding.gate_conditions(uuid, text) from public;
grant execute on function onboarding.gate_conditions(uuid, text) to authenticated;
