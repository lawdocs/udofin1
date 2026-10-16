-- Phase 08a, forward migration 919: a lender can ask for a settlement account to be set up.
--
-- tenancy.lender_settlement_accounts (Phase 02) is the lender's own account a payment settles into (ADR 0008: never a Udofin account).
-- Phase 08a added the way a settlement account becomes VERIFIED (payments.link_settlement_account, through a verified registry entry), but
-- nothing in the repository created the row to be linked: the Phase 02 comment said it is "written by the system", and no function did.
-- Without this the first payment setup cannot be done end to end.
--
-- The lender's maker (payment.configure, second factor) names the account by label, bank and MASKED reference only. The row starts
-- `unverified` and can never be used for a payment until a platform user links it to a verified registry entry whose masked reference
-- matches (the guard trigger already insists). Nothing here accepts, stores or checks a full account number: the label and the bank
-- name are refused if they carry a run of six or more digits, and the masked reference has the table's own shape (letters X or * and at
-- most four digits).
create or replace function payments.request_settlement_account(p_lender uuid, p_label text, p_bank_name text, p_masked_ref text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.payments_require_lender(p_lender, 'payment.configure');
  v_label text := btrim(p_label);
  v_bank text := btrim(p_bank_name);
  v_existing tenancy.lender_settlement_accounts;
  v_id uuid;
begin
  if v_label is null or length(v_label) not between 2 and 80 or v_bank is null or length(v_bank) not between 2 and 120
     or p_masked_ref is null or p_masked_ref !~ '^[X*]{2,}[0-9]{2,4}$'
     or v_label ~ '[0-9]{6,}' or v_bank ~ '[0-9]{6,}' then
    raise exception 'invalid settlement account request' using errcode = '22023', hint = 'settlement_account_invalid';
  end if;
  select * into v_existing from tenancy.lender_settlement_accounts s
   where s.lender_org_id = p_lender and lower(s.bank_name) = lower(v_bank) and s.masked_account_ref = p_masked_ref
   order by s.created_at limit 1;
  if found then
    if v_existing.label = v_label then
      return v_existing.id;
    end if;
    raise exception 'a settlement account with this bank and masked reference already exists' using errcode = '23505', hint = 'settlement_account_exists';
  end if;
  if (select count(*) from tenancy.lender_settlement_accounts s where s.lender_org_id = p_lender) >= 20 then
    raise exception 'too many settlement accounts' using errcode = '22023', hint = 'too_many_settlement_accounts';
  end if;
  insert into tenancy.lender_settlement_accounts (lender_org_id, label, bank_name, masked_account_ref)
  values (p_lender, v_label, v_bank, p_masked_ref)
  returning id into v_id;
  perform private.write_payments_audit(p_lender, 'payments.settlement_account.requested', 'settlement_account', v_id::text, '{}'::jsonb);
  return v_id;
end
$$;
comment on function payments.request_settlement_account(uuid, text, text, text) is
  'A lender maker (payment.configure, second factor) asks for one of the lender''s own settlement accounts to be set up: label, bank and MASKED reference only (a run of six or more digits in the label or bank name is refused). The row starts unverified and becomes usable only when a platform user links it to a verified registry entry (payments.link_settlement_account). Idempotent on lender, bank and masked reference. At most 20 per lender.';
revoke all on function payments.request_settlement_account(uuid, text, text, text) from public;
grant execute on function payments.request_settlement_account(uuid, text, text, text) to authenticated;
