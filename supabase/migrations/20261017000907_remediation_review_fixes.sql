-- =============================================================================================
-- Fixes from the independent review of the Phase 01/02 remediation (14 October 2026).
--
--   SEC-1 / DB-1  servicing.loan_account_events is meant to be written only by its trigger, but
--                 service_role kept INSERT through the default privileges, so code running under the
--                 system login could forge history rows. The privilege is removed (the trigger is a
--                 SECURITY DEFINER function and does not need it); SELECT stays for housekeeping reads.
--   SEC-6 / DB-4  The same table exposed actor_user_id (a staff user id) to the borrower through the
--                 borrower read policy. Borrowers have no use for the audit trail of lender and platform
--                 changes, so that policy is dropped. Lenders keep their policy. (Latent exposure: every
--                 row written today has a null actor_user_id.)
--   DB-3          The payment-success guard compared amount_minor only. provider_events had no currency,
--                 so an event in another currency with the same minor-unit number would match. The event
--                 now carries an optional currency (INR is the only value accepted) and success requires
--                 it to be present and equal to the intent's currency. An event without a currency can
--                 never authorise success; the adapter must state what the provider reported.
--
-- Forward-only. No data is migrated: no payment data and no history written by anything but the trigger.
-- =============================================================================================

revoke insert, update, delete, references, trigger on servicing.loan_account_events from service_role;
comment on table servicing.loan_account_events is
  'Append-only history of what the lender''s LMS reported for a loan account: status, sanctioned and disbursed amounts, disbursement evidence, each with old and new value, actor and time. Written only by the trigger private.record_loan_account_event (SECURITY DEFINER); no role has INSERT, UPDATE or DELETE. Readable by lenders with loan.read; not readable by borrowers. Owner: servicing module.';

drop policy if exists loan_account_events_borrower_read on servicing.loan_account_events;

alter table payments.provider_events
  add column currency char(3) check (currency is null or currency = 'INR');
comment on column payments.provider_events.currency is
  'Currency the provider reported for amount_minor. Null when the provider did not say; such an event can never authorise success. INR is the only value accepted.';

create or replace function private.protect_payment_intent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_actor text := private.current_actor();
begin
  if tg_op = 'INSERT' then
    if new.status <> 'created' then
      raise exception 'payment intents must start as created' using errcode = '23514';
    end if;
    if not exists (
      select 1 from servicing.loan_accounts la
      where la.id = new.loan_account_id and la.borrower_id = new.borrower_id and la.status = 'active'
    ) then
      raise exception 'payment intent must belong to the borrower''s active loan' using errcode = '23514';
    end if;
    return new;
  end if;

  if (to_jsonb(new) - array['status', 'provider_order_ref', 'updated_at'])
     is distinct from (to_jsonb(old) - array['status', 'provider_order_ref', 'updated_at']) then
    raise exception 'payment intent amount, account and parties are immutable' using errcode = 'P0001';
  end if;
  if old.provider_order_ref is not null and new.provider_order_ref is distinct from old.provider_order_ref then
    raise exception 'provider order reference cannot change once set' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status then
    if not (
      (old.status = 'created' and new.status in ('pending', 'failed', 'expired', 'cancelled'))
      or (old.status = 'pending' and new.status in ('succeeded', 'failed', 'expired'))
    ) then
      raise exception 'payment intent transition % -> % is not allowed', old.status, new.status using errcode = 'P0001';
    end if;
    if v_actor <> 'system' and not (old.status = 'created' and new.status = 'cancelled') then
      raise exception 'only the system may move a payment intent to %', new.status using errcode = '42501';
    end if;
    -- Success needs ONE event that is signature-verified, belongs to this intent, lender and provider, carries a
    -- success status from the list above and reports exactly the intent's amount. A failed, unverified, mismatching
    -- or amount-less event proves nothing.
    if new.status = 'succeeded' and not exists (
      select 1 from payments.provider_events pe
      where pe.payment_intent_id = new.id
        and pe.lender_org_id = new.lender_org_id
        and pe.provider = new.provider
        and pe.signature_verified
        and pe.provider_status = any (private.payment_success_statuses())
        and pe.amount_minor is not null
        and pe.amount_minor = new.amount_minor
        and pe.currency is not null
        and pe.currency = new.currency
    ) then
      raise exception 'a payment can be marked succeeded only after a signature-verified provider event with a success status, the same amount and the same currency'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;
