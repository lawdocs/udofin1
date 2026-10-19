-- Phase 07 security review fixes: segregation of duties covers the person who typed the figures, the preparer
-- is no longer movable, a sandbox signing result cannot advance a real application,  uploads can be authorised before any bytes are stored.

create or replace function documents.approve_document(p_doc uuid, p_sha256 text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d documents.items := private.assert_lender_document(p_doc, true);
begin
  select * into d from documents.items where id = p_doc for update;
  if d.approval_status <> 'draft' or d.issuance_status <> 'not_issued' then
    raise exception 'document already decided' using errcode = '55000', hint = 'already_decided';
  end if;
  if p_sha256 is distinct from d.sha256 then
    raise exception 'the file you reviewed is not the current file' using errcode = '55000', hint = 'hash_mismatch';
  end if;
  if ((d.prepared_by is not null and d.prepared_by = (select auth.uid()))
      or exists (select 1 from documents.kfs_inputs ki where ki.id = d.kfs_input_id and ki.submitted_by = (select auth.uid())))
     and not coalesce((select c.document_self_approval from lending.lender_connectors c where c.lender_org_id = d.lender_org_id), false) then
    raise exception 'a different person must approve' using errcode = '42501', hint = 'segregation_of_duties';
  end if;
  update documents.items set approval_status = 'lender_approved', approved_by = (select auth.uid()), approved_at = now(), approved_sha256 = p_sha256 where id = p_doc;
  perform private.doc_event(p_doc, d.lender_org_id, 'lender_approved', jsonb_build_object('sha256', p_sha256));
  perform lending.audit_event('documents.approved', 'document', p_doc::text);
end
$$;

create or replace function documents.record_signing_event(p_request uuid, p_to text, p_provider_ref text, p_evidence_ref text, p_detail jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s documents.signing_requests;
  a lending.applications;
  ok boolean;
begin
  if private.invoking_role() <> 'service_role' then raise exception 'system only' using errcode = '42501'; end if;
  select * into s from documents.signing_requests where id = p_request for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if s.state = p_to then return jsonb_build_object('state', s.state, 'unchanged', true); end if;
  ok := case s.state
    when 'ready_for_signing' then p_to in ('initiated', 'failed', 'cancelled', 'requires_reconciliation')
    when 'initiated' then p_to in ('awaiting_borrower', 'executed', 'failed', 'expired', 'cancelled', 'requires_reconciliation')
    when 'awaiting_borrower' then p_to in ('executed', 'failed', 'expired', 'cancelled', 'requires_reconciliation')
    when 'requires_reconciliation' then p_to in ('initiated', 'awaiting_borrower', 'executed', 'failed', 'expired', 'cancelled')
    else false end;
  if not ok then raise exception 'invalid signing transition % -> %', s.state, p_to using errcode = '55000', hint = 'invalid_transition'; end if;
  update documents.signing_requests set state = p_to, updated_at = now(),
    provider_ref = coalesce(left(p_provider_ref, 100), provider_ref), evidence_ref = coalesce(left(p_evidence_ref, 200), evidence_ref),
    uncertain_since = case when p_to = 'requires_reconciliation' then coalesce(uncertain_since, now()) else null end,
    executed_at = case when p_to = 'executed' then now() else executed_at end
   where id = p_request;
  insert into documents.signing_events (request_id, from_state, to_state, detail) values (p_request, s.state, p_to, coalesce(p_detail, '{}'::jsonb));
  if p_to = 'executed' then
    select * into a from lending.applications where id = s.application_id for update;
    if a.status = 'agreement_pending' and s.provider_mode in ('live', 'mock') then
      perform set_config('udofin.transition_reason', 'agreement_executed', true);
      update lending.applications set status = 'agreement_executed' where id = a.id;
    end if;
    perform private.doc_event(s.document_id, s.lender_org_id, 'agreement_executed', jsonb_build_object('requestId', p_request, 'mode', s.provider_mode), 'system');
  else
    perform private.doc_event(s.document_id, s.lender_org_id, 'signing_' || p_to, jsonb_build_object('requestId', p_request), 'system');
  end if;
  return jsonb_build_object('state', p_to, 'unchanged', false);
end
$$;

create or replace function private.protect_document_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  movable text[] := array['approval_status', 'approved_by', 'approved_at', 'approved_sha256', 'issuance_status', 'issued_at', 'issued_by',
                          'superseded_by_id'];
begin
  if (to_jsonb(new) - movable) is distinct from (to_jsonb(old) - movable) then
    raise exception 'an issued or generated document is immutable; create a new version' using errcode = 'P0001', hint = 'document_immutable';
  end if;
  if new.approval_status is distinct from old.approval_status
     and not ((old.approval_status = 'draft' and new.approval_status in ('lender_approved', 'rejected'))) then
    raise exception 'invalid approval change % -> %', old.approval_status, new.approval_status using errcode = 'P0001';
  end if;
  if new.issuance_status is distinct from old.issuance_status and not (
       (old.issuance_status = 'not_issued' and new.issuance_status in ('issued', 'withdrawn', 'expired'))
    or (old.issuance_status = 'issued' and new.issuance_status in ('superseded', 'withdrawn', 'expired'))) then
    raise exception 'invalid issuance change % -> %', old.issuance_status, new.issuance_status using errcode = 'P0001';
  end if;
  if new.issuance_status = 'issued' and old.issuance_status <> 'issued' then
    if new.approval_status <> 'lender_approved' or new.approved_sha256 is distinct from new.sha256 then
      raise exception 'only a lender-approved document with a matching hash can be issued' using errcode = 'P0001', hint = 'approval_required';
    end if;
  end if;
  return new;
end
$$;


create or replace function documents.assert_can_prepare(p_offer uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_lender_prepare(p_offer);
end
$$;
revoke all on function documents.assert_can_prepare(uuid) from public;
grant execute on function documents.assert_can_prepare(uuid) to authenticated;
comment on function documents.assert_can_prepare(uuid) is 'Authorises a lender upload (tenant, permission, AAL2) before any file is written to the store.';
