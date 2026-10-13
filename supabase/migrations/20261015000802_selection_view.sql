-- Phase 06, part 3: what the borrower sees while choosing lenders and giving each lender its own consent.
-- Wording missing or unapproved is reported as such: nothing is invented and sharing stays blocked.
create or replace function lending.selection_view(p_request uuid, p_language text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_sel lending.lender_selections;
begin
  if p_language not in ('en', 'hi') then raise exception 'invalid language' using errcode = '22023'; end if;
  if not exists (select 1 from lending.loan_requests r where r.id = p_request and r.borrower_id = v_borrower) then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  select * into v_sel from lending.lender_selections where loan_request_id = p_request and borrower_id = v_borrower and status = 'open';
  return jsonb_build_object(
    'maxLenders', 5,
    'routedCount', (select count(*) from lending.applications a where a.loan_request_id = p_request),
    'selectionId', v_sel.id,
    'items', case when v_sel.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'lenderId', i.lender_org_id, 'lenderName', o.display_name, 'productVersionId', i.product_version_id, 'productName', p.name,
        'status', i.status,
        'consentInForce', private.lender_consent_ok(v_borrower, i.lender_org_id, p_request),
        'notice', (select case when n.id is null then null else jsonb_build_object(
            'id', n.id, 'version', n.version, 'title', n.title, 'bodyMarkdown', n.body_markdown, 'bodySha256', n.body_sha256,
            'language', n.language, 'reviewStatus', n.review_status, 'languageFallback', n.language <> p_language) end
          from (select (private.current_lender_notice(i.lender_org_id, p_language)).*) n)) order by o.display_name)
      from lending.lender_selection_items i
      join tenancy.organizations o on o.id = i.lender_org_id
      join lending.loan_product_versions v on v.id = i.product_version_id
      join lending.loan_products p on p.id = v.product_id
      where i.selection_id = v_sel.id and i.status <> 'removed'), '[]'::jsonb) end);
end
$$;
revoke all on function lending.selection_view(uuid, text) from public;
grant execute on function lending.selection_view(uuid, text) to authenticated;
