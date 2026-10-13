-- Authorisation matrix (spec W6). This is a SNAPSHOT of what each database role may do on every
-- domain table, and of which permissions each system role carries. It fails on any difference, in
-- either direction, so a grant, table or permission cannot change by accident: change the migration
-- AND this file in the same pull request, with a reviewer who reads the diff of THIS file.
--
-- Letters: s=select i=insert u=update d=delete, '-' = none. `anon` must never have access.
-- `forced` = row-level security is also enforced for the table owner. Reference tables and
-- consent.notices are deliberately not forced: SECURITY DEFINER functions owned by the migration
-- role read them; end users and service_role are governed by grants and policies regardless.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

create function pg_temp.privs(r text, o oid) returns text language sql as $fn$
  select coalesce(nullif(concat(
    case when has_any_column_privilege(r, o, 'select') then 's' end,
    case when has_any_column_privilege(r, o, 'insert') then 'i' end,
    case when has_any_column_privilege(r, o, 'update') then 'u' end,
    case when has_table_privilege(r, o, 'delete') then 'd' end), ''), '-')
$fn$;

create temp table expected_tables (tbl text primary key, anon text, authenticated text, service_role text, forced boolean);
insert into expected_tables values
  ('audit.anchors', '-', 's', 'siud', true),
  ('audit.events', '-', 's', 'siud', true),
  ('consent.notices', '-', 's', 'siud', false),
  ('consent.records', '-', 'si', 'siud', true),
  ('identity.borrowers', '-', 'su', 'siud', true),
  ('identity.communication_preferences', '-', 's', 'siud', true),
  ('identity.deletion_requests', '-', 's', 'siud', true),
  ('identity.device_attestations', '-', '-', 'siud', true),
  ('identity.integrity_nonces', '-', '-', 'siud', true),
  ('identity.stepup_challenges', '-', '-', 'siud', true),
  ('lending.loan_purposes', '-', 's', 'siud', true),
  ('lending.loan_request_events', '-', 's', 'siud', true),
  ('lending.application_events', '-', 's', 'siud', true),
  ('lending.application_transitions', '-', 's', 'siud', false),
  ('onboarding.accounting_profiles', '-', 's', 'siud', true),
  ('onboarding.accounting_waivers', '-', 's', 'siud', true),
  ('onboarding.platform_settings', '-', 's', 'siud', true),
  ('onboarding.documents', '-', 's', 'siud', true),
  ('onboarding.gate_requests', '-', 's', 'siud', true),
  ('onboarding.institution_categories', '-', 's', 'siud', true),
  ('onboarding.integrations', '-', 's', 'siud', true),
  ('onboarding.lender_contracts', '-', 's', 'siud', true),
  ('onboarding.lender_gates', '-', 's', 'siud', true),
  ('onboarding.lender_profiles', '-', 's', 'siud', true),
  ('onboarding.lender_requirements', '-', 's', 'siud', true),
  ('onboarding.lender_services', '-', 's', 'siud', true),
  ('onboarding.requirement_dependencies', '-', 's', 'siud', true),
  ('onboarding.requirement_templates', '-', 's', 'siud', true),
  ('onboarding.service_categories', '-', 's', 'siud', true),
  ('onboarding.service_versions', '-', 's', 'siud', true),
  ('onboarding.verification_history', '-', 's', 'siud', true),
  ('ops.idempotency_keys', '-', '-', 'siud', true),
  ('ops.outbox_events', '-', '-', 'siud', true),
  ('lending.lender_connectors', '-', 's', 'siud', true),
  ('lending.lender_selections', '-', 's', 'siud', true),
  ('lending.lender_selection_items', '-', 's', 'siud', true),
  ('lending.application_routing', '-', 's', 'siud', true),
  ('lending.routing_events', '-', 's', 'siud', true),
  ('lending.application_checks', '-', 's', 'siud', true),
  ('lending.lender_decisions', '-', 's', 'siud', true),
  ('lending.inbound_messages', '-', 's', 'siud', true),
  ('lending.offer_intake', '-', 's', 'siud', true),
  ('lending.comparison_runs', '-', 's', 'siud', true),
  ('lending.comparison_nonoffers', '-', 's', 'siud', true),
  ('lending.matching_rule_proposals', '-', 's', 'siud', true),
  ('lending.applications', '-', 'su', 'siud', true),
  ('lending.loan_product_versions', '-', 'siu', 'siud', true),
  ('lending.loan_products', '-', 'siu', 'siud', true),
  ('lending.loan_requests', '-', 'siu', 'siud', true),
  ('lending.matching_rule_versions', '-', 's', 'siud', true),
  ('lending.offer_displays', '-', 's', 'siud', true),
  ('lending.offers', '-', 'siu', 'siud', true),
  ('lending.panel_views', '-', 'siu', 'siud', true),
  ('lending.product_categories', '-', 's', 'siud', false),
  ('payments.payment_intents', '-', 'su', 'siud', true),
  ('payments.provider_events', '-', 's', 'siud', true),
  ('servicing.loan_accounts', '-', 's', 'siud', true),
  ('servicing.schedule_installments', '-', 's', 'siud', true),
  ('servicing.schedule_snapshots', '-', 's', 'siud', true),
  ('tenancy.change_requests', '-', 's', 'siud', true),
  ('tenancy.lender_settlement_accounts', '-', 's', 'siud', true),
  ('tenancy.membership_roles', '-', 's', 'siud', true),
  ('tenancy.memberships', '-', 's', 'siud', true),
  ('tenancy.organizations', '-', 's', 'siud', true),
  ('tenancy.permissions', '-', 's', 'siud', false),
  ('tenancy.role_permissions', '-', 's', 'siud', false),
  ('tenancy.roles', '-', 's', 'siud', false);

create temp table actual_tables as
select n.nspname || '.' || c.relname as tbl, c.oid as oid, c.relrowsecurity as rls, c.relforcerowsecurity as forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and n.nspname in ('tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments', 'ops', 'onboarding');

select is((select coalesce(string_agg(tbl, ', '), '') from (select tbl from actual_tables except select tbl from expected_tables) x), '',
  'every domain table has a row in the matrix (add new tables here)');
select is((select coalesce(string_agg(tbl, ', '), '') from (select tbl from expected_tables except select tbl from actual_tables) x), '',
  'the matrix names no table that does not exist');
select is((select coalesce(string_agg(tbl, ', '), '') from actual_tables where not rls), '',
  'row-level security is enabled on every domain table');
select is((select coalesce(string_agg(a.tbl, ', '), '') from actual_tables a join expected_tables e using (tbl) where a.forced <> e.forced), '',
  'forced row-level security matches the matrix');
select is((select coalesce(string_agg(a.tbl || ' anon=' || pg_temp.privs('anon', a.oid), ', '), '')
           from actual_tables a join expected_tables e using (tbl) where pg_temp.privs('anon', a.oid) <> e.anon), '',
  'anon privileges match the matrix (and are none)');
select is((select coalesce(string_agg(a.tbl || ' authenticated=' || pg_temp.privs('authenticated', a.oid), ', '), '')
           from actual_tables a join expected_tables e using (tbl) where pg_temp.privs('authenticated', a.oid) <> e.authenticated), '',
  'authenticated privileges match the matrix');
select is((select coalesce(string_agg(a.tbl || ' service_role=' || pg_temp.privs('service_role', a.oid), ', '), '')
           from actual_tables a join expected_tables e using (tbl) where pg_temp.privs('service_role', a.oid) <> e.service_role), '',
  'service_role privileges match the matrix');

-- Permission catalogue and system roles ------------------------------------------------------------------
create temp table expected_permissions (key text primary key, platform_grantable boolean, platform_only boolean);
insert into expected_permissions values
  ('application.decide', false, false),
  ('platform.lender_routing.manage', false, true),
  ('application.read', true, false),
  ('audit.read', true, false),
  ('collections.manage', false, true),
  ('collections.policy', false, false),
  ('collections.read', false, false),
  ('collections.work', false, true),
  ('dlg.invoke', false, false),
  ('dlg.manage', false, true),
  ('dlg.read', false, false),
  ('loan.read', true, false),
  ('onboarding.approve', false, true),
  ('onboarding.compliance_signoff', false, true),
  ('onboarding.manage', false, true),
  ('onboarding.read', true, false),
  ('onboarding.submit', false, false),
  ('org.members.manage', false, false),
  ('org.members.read', true, false),
  ('payment.read', true, false),
  ('platform.consent_notices.manage', false, true),
  ('platform.organizations.manage', false, true),
  ('platform.organizations.read', false, true),
  ('product.approve', false, false),
  ('product.configure', false, false),
  ('product.read', true, false);
create temp table expected_role_permissions (role_key text, permission_key text, primary key (role_key, permission_key));
insert into expected_role_permissions values
  ('lender.credit_officer', 'application.decide'),
  ('lender.credit_officer', 'application.read'),
  ('lender.credit_officer', 'loan.read'),
  ('lender.credit_officer', 'product.read'),
  ('lender.dlg_invoker', 'dlg.invoke'),
  ('lender.dlg_invoker', 'dlg.read'),
  ('lender.lender_admin', 'application.read'),
  ('lender.lender_admin', 'audit.read'),
  ('lender.lender_admin', 'collections.read'),
  ('lender.lender_admin', 'dlg.read'),
  ('lender.lender_admin', 'loan.read'),
  ('lender.lender_admin', 'org.members.manage'),
  ('lender.lender_admin', 'org.members.read'),
  ('lender.lender_admin', 'payment.read'),
  ('lender.lender_admin', 'product.configure'),
  ('lender.lender_admin', 'product.read'),
  ('lender.lender_admin', 'onboarding.read'),
  ('lender.lender_admin', 'onboarding.submit'),
  ('lender.onboarding_contact', 'onboarding.read'),
  ('lender.onboarding_contact', 'onboarding.submit'),
  ('platform.compliance_officer', 'onboarding.compliance_signoff'),
  ('platform.compliance_officer', 'onboarding.read'),
  ('platform.onboarding_approver', 'onboarding.approve'),
  ('platform.onboarding_approver', 'onboarding.read'),
  ('platform.onboarding_manager', 'onboarding.manage'),
  ('platform.onboarding_manager', 'onboarding.read'),
  ('lender.product_approver', 'product.approve'),
  ('lender.product_approver', 'product.read'),
  ('lender.recovery_policy_owner', 'collections.policy'),
  ('lender.recovery_policy_owner', 'collections.read'),
  ('lender.viewer', 'application.read'),
  ('lender.viewer', 'loan.read'),
  ('lender.viewer', 'payment.read'),
  ('lender.viewer', 'product.read'),
  ('platform.auditor', 'application.read'),
  ('platform.auditor', 'audit.read'),
  ('platform.auditor', 'loan.read'),
  ('platform.auditor', 'payment.read'),
  ('platform.auditor', 'platform.organizations.read'),
  ('platform.auditor', 'product.read'),
  ('platform.collections_agent', 'collections.work'),
  ('platform.collections_head', 'collections.manage'),
  ('platform.dlg_finance', 'dlg.manage'),
  ('platform.dlg_finance', 'dlg.read'),
  ('platform.operations_agent', 'application.read'),
  ('platform.operations_agent', 'loan.read'),
  ('platform.operations_agent', 'payment.read'),
  ('platform.operations_agent', 'platform.organizations.read'),
  ('platform.operations_agent', 'product.read'),
  ('platform.platform_admin', 'org.members.read'),
  ('platform.platform_admin', 'platform.lender_routing.manage'),
  ('platform.platform_admin', 'platform.consent_notices.manage'),
  ('platform.platform_admin', 'platform.organizations.manage'),
  ('platform.platform_admin', 'platform.organizations.read');

select is(
  (select coalesce(string_agg(d, '; ' order by d), '') from (
     select 'permission ' || key as d from (select key, platform_grantable, platform_only from tenancy.permissions
        except select key, platform_grantable, platform_only from expected_permissions) a
     union all
     select 'missing permission ' || key from (select key, platform_grantable, platform_only from expected_permissions
        except select key, platform_grantable, platform_only from tenancy.permissions) b
     union all
     select 'role grant ' || role_key || ' -> ' || permission_key from (
        select r.applies_to || '.' || r.key as role_key, rp.permission_key
        from tenancy.role_permissions rp join tenancy.roles r on r.id = rp.role_id where r.org_id is null
        except select role_key, permission_key from expected_role_permissions) c
     union all
     select 'missing role grant ' || role_key || ' -> ' || permission_key from (
        select role_key, permission_key from expected_role_permissions
        except select r.applies_to || '.' || r.key, rp.permission_key
        from tenancy.role_permissions rp join tenancy.roles r on r.id = rp.role_id where r.org_id is null) d2
  ) q), '',
  'permission catalogue and system role grants match the snapshot exactly');

select * from finish();
rollback;
