-- Phase 05 helpers read by the borrower-facing API.

-- Whether a separate marketing consent may be offered. Off at launch (D-14).
create or replace function consent.marketing_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.bool_value from onboarding.platform_settings s where s.key = 'marketing_enabled'), false)
$$;
revoke all on function consent.marketing_enabled() from public;
grant execute on function consent.marketing_enabled() to authenticated;
