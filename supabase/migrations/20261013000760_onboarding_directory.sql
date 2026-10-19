-- Phase 04 (addendum A): a minimal directory of lenders for onboarding screens.
-- Onboarding staff do not hold `platform.organizations.read`, so organisation names are exposed
-- through this narrow function, limited to lenders the caller may read onboarding data for.
create or replace function onboarding.lender_directory()
returns table (
  lender_org_id uuid, legal_name text, display_name text, organization_status text,
  category_key text, category_label text, stage text, verification_status text, accounting_status text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.legal_name, o.display_name, o.status::text, p.category_key, c.label, g.stage, p.verification_status,
         (select a.status from onboarding.accounting_profiles a where a.lender_org_id = o.id order by a.version_no desc limit 1)
  from tenancy.organizations o
  left join onboarding.lender_profiles p on p.lender_org_id = o.id
  left join onboarding.institution_categories c on c.key = p.category_key
  left join onboarding.lender_gates g on g.lender_org_id = o.id
  where o.kind = 'lender' and o.status <> 'offboarded'
    and o.id in (select private.orgs_with_permission('onboarding.read'))
  order by o.legal_name, o.id
$$;
revoke all on function onboarding.lender_directory() from public;
grant execute on function onboarding.lender_directory() to authenticated;
