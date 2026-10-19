-- Phase 08a, forward migration 918: a mandate hand-off that never reached a provider is recorded as such.
--
-- Until now the worker had three words for the result of asking a provider to take a mandate request: handoff, rejected (a definite
-- refusal) and unknown (the provider may have acted). When the worker could not ask at all (no provider configured for the lender, the rail
-- unsupported, the configuration no longer active, the provider not resolvable here) it had to say "rejected", and the history then read
-- "failed after hand-off" with nothing to tell a refusal from "never sent".
--
-- A fourth word, not_sent, closes the draft as failed with the SYSTEM as the source (the provider never saw the request, like an abandoned
-- draft the sweep closes), while a refusal keeps the source "handoff". The borrower sees the same word for both ("failed": it could not
-- be set up); the lender and the platform can tell them apart from the history. No exception is opened: nothing is unresolved, because
-- nothing was sent.
create or replace function payments.record_mandate_handoff(p_mandate uuid, p_outcome text, p_provider_mandate_ref text default null, p_expires_at timestamptz default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  m payments.mandates;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('handoff', 'rejected', 'unknown', 'not_sent')
     or (p_outcome = 'handoff' and (p_provider_mandate_ref is null or p_provider_mandate_ref !~ '^[A-Za-z0-9._:=+/-]{1,200}$'))
     or (p_outcome <> 'handoff' and p_provider_mandate_ref is not null) then
    raise exception 'invalid hand-off result' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into m from payments.mandates x where x.id = p_mandate for update;
  if not found then
    raise exception 'mandate not found' using errcode = 'P0002';
  end if;
  if m.status <> 'draft' then
    return m.status;
  end if;
  if p_outcome = 'handoff' then
    update payments.mandates set provider_mandate_ref = p_provider_mandate_ref, handoff_expires_at = p_expires_at where id = m.id;
    perform private.mandate_move(m.id, 'registration_pending', 'handoff', null, clock_timestamp());
    return 'registration_pending';
  elsif p_outcome = 'rejected' then
    perform private.mandate_move(m.id, 'failed', 'handoff', null, clock_timestamp());
    return 'failed';
  elsif p_outcome = 'not_sent' then
    perform private.mandate_move(m.id, 'failed', 'system', null, clock_timestamp());
    return 'failed';
  end if;
  perform private.mandate_move(m.id, 'requires_reconciliation', 'handoff', null, clock_timestamp());
  perform private.raise_exception_impl(m.lender_org_id, 'mandate_unresolved', 'warning', 'platform', jsonb_build_object('mandate_id', m.id::text));
  return 'requires_reconciliation';
end
$$;
comment on function payments.record_mandate_handoff(uuid, text, text, timestamptz) is
  'System only. Records what happened when the provider was asked to take a mandate request: handoff (draft -> registration_pending, the provider reference is stored; NOT an activation), rejected (a definite refusal: draft -> failed, source handoff), unknown (draft -> requires_reconciliation and a platform exception: look the mandate up before any retry) or not_sent (nothing reached any provider: draft -> failed, source system). A mandate that has already left the draft answers its status.';
