-- =============================================================================================
-- Phase 07, part 2c: borrower reads, acknowledgement, offer acceptance, signing boundary, delivery and access evidence.
-- Acknowledgement, acceptance, signature and delivery are separate facts; none implies another.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Acknowledgement wording: versioned notices (the same approval gate as consent wording)
-- ---------------------------------------------------------------------------------------------
create or replace function private.current_ack_notice(p_lender uuid, p_language text)
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
   where n.purpose = 'kfs_acknowledgement' and n.status = 'published' and n.language = p_language and n.review_status = 'approved'
     and (n.lender_org_id = p_lender or n.lender_org_id is null)
   order by (n.lender_org_id is not null) desc, n.version desc limit 1;
  return v;
end
$$;
revoke all on function private.current_ack_notice(uuid, text) from public;

-- ---------------------------------------------------------------------------------------------
-- Access: the API calls this before streaming bytes. A borrower sees only their own issued (or closed) documents;
-- a lender sees documents of its own applications. Each call is recorded without content.
-- ---------------------------------------------------------------------------------------------
create or replace function documents.open_document(p_doc uuid, p_purpose text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d documents.items;
  v_borrower uuid := private.my_borrower_id();
  v_actor text;
begin
  if p_purpose not in ('view', 'download') then raise exception 'invalid purpose' using errcode = '22023'; end if;
  select * into d from documents.items where id = p_doc;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if v_borrower is not null and d.borrower_id = v_borrower and d.issuance_status <> 'not_issued' then
    v_actor := 'borrower';
  elsif v_borrower is null and d.lender_org_id in (select private.orgs_with_permission('application.read')) then
    v_actor := 'lender';
  else
    raise exception 'not found' using errcode = 'P0002';
  end if;
  insert into documents.access_log (document_id, lender_org_id, actor_type, actor_user_id, purpose)
  values (p_doc, d.lender_org_id, v_actor, (select auth.uid()), p_purpose);
  return jsonb_build_object('documentId', d.id, 'storageKey', d.storage_key, 'sha256', d.sha256, 'mimeType', d.mime_type,
                            'documentType', d.document_type, 'version', d.version);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Borrower: everything about one application's documents in one read
-- ---------------------------------------------------------------------------------------------
create or replace function documents.application_documents(p_application uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  a lending.applications;
  o lending.offers;
  k documents.items;
  g documents.items;
  v_ack documents.acknowledgements;
  v_acc documents.acceptances;
  v_sign documents.signing_requests;
  v_lender text;
begin
  select * into a from lending.applications where id = p_application and borrower_id = v_borrower;
  if not found then raise exception 'application not found' using errcode = 'P0002'; end if;
  select o2.display_name into v_lender from tenancy.organizations o2 where o2.id = a.lender_org_id;
  select * into o from lending.offers x where x.application_id = p_application order by x.issued_at desc, x.revision desc limit 1;
  if o.id is not null then
    select * into k from documents.items x where x.offer_id = o.id and x.document_type = 'kfs' and x.issuance_status <> 'not_issued' order by x.version desc limit 1;
    select * into g from documents.items x where x.offer_id = o.id and x.document_type = 'loan_agreement' and x.issuance_status <> 'not_issued' order by x.version desc limit 1;
    select * into v_acc from documents.acceptances x where x.offer_id = o.id;
  end if;
  if k.id is not null then select * into v_ack from documents.acknowledgements x where x.document_id = k.id and x.borrower_id = v_borrower; end if;
  if g.id is not null then select * into v_sign from documents.signing_requests x where x.document_id = g.id order by x.requested_at desc limit 1; end if;
  return jsonb_build_object(
    'applicationId', a.id, 'applicationStatus', a.status, 'lenderName', v_lender,
    'offer', case when o.id is null then null else jsonb_build_object(
      'offerId', o.id, 'revision', o.revision, 'status', o.status, 'validUntil', o.valid_until, 'principalMinor', o.principal_minor, 'tenureDays', o.tenure_days,
      'aprBps', o.apr_bps, 'monthlyRepaymentMinor', o.monthly_repayment_minor, 'lenderOfferRef', o.lender_offer_ref) end,
    'kfs', case when k.id is null then null else jsonb_build_object(
      'documentId', k.id, 'version', k.version, 'issuanceStatus', k.issuance_status, 'proposalNo', k.proposal_no, 'language', k.language, 'sourceMode', k.source_mode,
      'validFrom', k.kfs_valid_from, 'validUntil', k.kfs_valid_until, 'issuedAt', k.issued_at, 'sha256', k.sha256, 'contentDigest', k.content_digest) end,
    'acknowledgement', case when v_ack.id is null then null else jsonb_build_object('acknowledgementId', v_ack.id, 'acknowledgedAt', v_ack.acknowledged_at, 'language', v_ack.language) end,
    'acceptance', case when v_acc.id is null then null else jsonb_build_object('acceptedAt', v_acc.accepted_at, 'signatureStatus', v_acc.signature_status,
                                                                                'disbursementStatus', v_acc.disbursement_status) end,
    'agreement', case when g.id is null then null else jsonb_build_object('documentId', g.id, 'version', g.version, 'issuanceStatus', g.issuance_status, 'issuedAt', g.issued_at) end,
    'signing', case when v_sign.id is null then null else jsonb_build_object('requestId', v_sign.id, 'state', v_sign.state, 'providerMode', v_sign.provider_mode, 'updatedAt', v_sign.updated_at) end,
    'documents', coalesce((select jsonb_agg(jsonb_build_object(
        'documentId', x.id, 'type', x.document_type, 'version', x.version, 'language', x.language, 'issuanceStatus', x.issuance_status, 'issuedAt', x.issued_at,
        'validUntil', x.kfs_valid_until, 'supersededById', x.superseded_by_id, 'proposalNo', x.proposal_no, 'sha256', x.sha256,
        'acknowledged', exists (select 1 from documents.acknowledgements y where y.document_id = x.id and y.borrower_id = v_borrower),
        'delivery', coalesce((select jsonb_agg(jsonb_build_object('channel', dl.channel, 'status', dl.status) order by dl.requested_at)
                                from documents.deliveries dl where dl.document_id = x.id), '[]'::jsonb))
        order by x.generated_at desc, x.version desc)
      from documents.items x where x.application_id = a.id and x.issuance_status <> 'not_issued'), '[]'::jsonb));
end
$$;

-- The KFS as readable sections (the lender's own figures, unchanged) plus the current wording to acknowledge it.
create or replace function documents.kfs_view(p_doc uuid, p_language text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  d documents.items;
  i documents.kfs_inputs;
  v_notice consent.notices;
  v_rule documents.applicability_rules;
  v_ack documents.acknowledgements;
begin
  select * into d from documents.items where id = p_doc and borrower_id = v_borrower and document_type = 'kfs' and issuance_status <> 'not_issued';
  if not found then raise exception 'document not found' using errcode = 'P0002'; end if;
  select * into i from documents.kfs_inputs where id = d.kfs_input_id;
  select * into v_rule from documents.applicability_rules where id = d.rule_id;
  v_notice := private.current_ack_notice(d.lender_org_id, p_language);
  if v_notice.id is null and p_language <> 'en' then v_notice := private.current_ack_notice(d.lender_org_id, 'en'); end if;
  select * into v_ack from documents.acknowledgements where document_id = p_doc and borrower_id = v_borrower;
  return jsonb_build_object(
    'documentId', d.id, 'version', d.version, 'issuanceStatus', d.issuance_status, 'proposalNo', d.proposal_no, 'language', d.language, 'sourceMode', d.source_mode,
    'validFrom', d.kfs_valid_from, 'validUntil', d.kfs_valid_until, 'sha256', d.sha256,
    'lenderName', (select o2.legal_name from tenancy.organizations o2 where o2.id = d.lender_org_id),
    -- Only a generated KFS has structured data; an uploaded KFS is shown as the lender's file.
    'data', case when i.mode = 'data' then i.data end,
    'ackSections', to_jsonb(coalesce(v_rule.ack_sections, '{}')),
    'wording', case when v_notice.id is null then null else jsonb_build_object(
        'noticeId', v_notice.id, 'version', v_notice.version, 'language', v_notice.language, 'title', v_notice.title, 'body', v_notice.body_markdown,
        'languageFallback', v_notice.language <> p_language) end,
    'acknowledged', v_ack.id is not null);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Acknowledgement: only an explicit action, on a document the borrower opened, with approved current wording
-- ---------------------------------------------------------------------------------------------
create or replace function documents.acknowledge(p_doc uuid, p_notice uuid, p_sections text[], p_action text, p_explanation_version text,
                                                 p_channel text, p_app_version text, p_idem text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  d documents.items;
  o lending.offers;
  a lending.applications;
  n consent.notices;
  v_rule documents.applicability_rules;
  v_existing documents.acknowledgements;
  v_id uuid;
  v_aal text := coalesce((select auth.jwt()) ->> 'aal', 'aal1');
begin
  select * into d from documents.items where id = p_doc and borrower_id = v_borrower and document_type = 'kfs' for update;
  if not found then raise exception 'document not found' using errcode = 'P0002'; end if;
  select * into v_existing from documents.acknowledgements where document_id = p_doc and borrower_id = v_borrower;
  if v_existing.id is not null then
    return jsonb_build_object('acknowledgementId', v_existing.id, 'acknowledgedAt', v_existing.acknowledged_at, 'replayed', true);
  end if;
  if p_action not in ('checkbox_and_button', 'button') then raise exception 'an explicit action is required' using errcode = '22023', hint = 'explicit_action_required'; end if;
  if p_channel not in ('mobile_app', 'web', 'assisted') then raise exception 'invalid channel' using errcode = '22023'; end if;
  if d.issuance_status <> 'issued' then raise exception 'the KFS is not current' using errcode = '55000', hint = 'kfs_not_current'; end if;
  if d.kfs_valid_until <= now() then raise exception 'the KFS validity has ended' using errcode = '55000', hint = 'kfs_expired'; end if;
  select * into o from lending.offers where id = d.offer_id;
  select * into a from lending.applications where id = d.application_id;
  if o.status = 'withdrawn' then raise exception 'the offer was withdrawn' using errcode = '55000', hint = 'offer_withdrawn'; end if;
  if o.status <> 'issued' or o.valid_until <= now() then raise exception 'the offer is not current' using errcode = '55000', hint = 'offer_not_current'; end if;
  if not private.lender_consent_ok(v_borrower, d.lender_org_id, a.loan_request_id) then
    raise exception 'consent for this lender is no longer in force' using errcode = '55000', hint = 'consent_withdrawn';
  end if;
  -- The borrower must have been given the actual file first.
  if not exists (select 1 from documents.access_log l where l.document_id = p_doc and l.actor_user_id = (select auth.uid()) and l.actor_type = 'borrower') then
    raise exception 'open the document first' using errcode = '55000', hint = 'document_not_opened';
  end if;
  select * into n from consent.notices where id = p_notice and purpose = 'kfs_acknowledgement' and status = 'published';
  if not found or (n.lender_org_id is not null and n.lender_org_id <> d.lender_org_id) then
    raise exception 'wording not found' using errcode = 'P0002', hint = 'wording_not_found';
  end if;
  if n.review_status <> 'approved' then raise exception 'this wording has not been approved' using errcode = '55000', hint = 'wording_not_approved'; end if;
  if n.version < (select max(x.version) from consent.notices x where x.purpose = 'kfs_acknowledgement' and x.language = n.language
                   and x.lender_org_id is not distinct from n.lender_org_id and x.status = 'published') then
    raise exception 'a newer version of this wording is published' using errcode = '55000', hint = 'wording_superseded';
  end if;
  select * into v_rule from documents.applicability_rules where id = d.rule_id;
  if v_rule.id is not null and not (v_rule.ack_sections <@ coalesce(p_sections, '{}')) then
    raise exception 'every section must have been shown' using errcode = '55000', hint = 'sections_not_shown';
  end if;
  insert into documents.acknowledgements (borrower_id, lender_org_id, application_id, offer_id, document_id, document_sha256, rule_id, template_id, language,
    wording_notice_id, wording_sha256, explanation_version, sections_viewed, action, auth_aal, channel, app_version, idempotency_ref)
  values (v_borrower, d.lender_org_id, d.application_id, d.offer_id, p_doc, d.sha256, d.rule_id, d.template_id, n.language, n.id, n.body_sha256,
          left(coalesce(p_explanation_version, 'v1'), 40), coalesce(p_sections, '{}'), p_action, case when v_aal = 'aal2' then 'aal2' else 'aal1' end,
          p_channel, left(p_app_version, 40), left(p_idem, 100))
  returning id into v_id;
  perform private.doc_event(p_doc, d.lender_org_id, 'acknowledged', jsonb_build_object('ackId', v_id));
  perform lending.audit_event('documents.kfs.acknowledged', 'document', p_doc::text, jsonb_build_object('language', n.language, 'noticeVersion', n.version));
  return jsonb_build_object('acknowledgementId', v_id, 'acknowledgedAt', now(), 'replayed', false);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Offer acceptance. One transaction: every check, the step-up consumption, the offer and application change, the evidence row.
-- It is NOT a signature and NOT a disbursement; the agreement is generated afterwards by a separate job.
-- ---------------------------------------------------------------------------------------------
create or replace function documents.accept_offer(p_offer uuid, p_kfs uuid, p_ack uuid, p_idem text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  o lending.offers;
  a lending.applications;
  d documents.items;
  k documents.acknowledgements;
  v_acc documents.acceptances;
  v_step uuid;
  v_id uuid;
begin
  select * into o from lending.offers where id = p_offer for update;
  if not found then raise exception 'offer not found' using errcode = 'P0002'; end if;
  select * into a from lending.applications where id = o.application_id and borrower_id = v_borrower for update;
  if not found then raise exception 'offer not found' using errcode = 'P0002'; end if;
  select * into v_acc from documents.acceptances where offer_id = p_offer;
  if v_acc.id is not null then
    if v_acc.borrower_id = v_borrower and p_idem is not null and v_acc.idempotency_ref = left(p_idem, 100) then
      return jsonb_build_object('acceptanceId', v_acc.id, 'acceptedAt', v_acc.accepted_at, 'applicationStatus', a.status, 'signatureStatus', 'not_signed',
                                'disbursementStatus', 'not_started', 'replayed', true);
    end if;
    raise exception 'the offer was already accepted' using errcode = '55000', hint = 'already_accepted';
  end if;
  if o.status = 'withdrawn' then raise exception 'the offer was withdrawn' using errcode = '55000', hint = 'offer_withdrawn'; end if;
  if o.status = 'expired' or o.valid_until <= now() then raise exception 'the offer has expired' using errcode = '55000', hint = 'offer_expired'; end if;
  if o.status <> 'issued' or a.status <> 'approved' then raise exception 'the offer is not current' using errcode = '55000', hint = 'offer_not_current'; end if;
  if exists (select 1 from lending.offers x where x.application_id = o.application_id and x.id <> o.id and x.status = 'issued' and x.revision > o.revision) then
    raise exception 'a newer offer revision exists' using errcode = '55000', hint = 'offer_superseded';
  end if;
  if not private.lender_consent_ok(v_borrower, a.lender_org_id, a.loan_request_id) then
    raise exception 'consent for this lender is no longer in force' using errcode = '55000', hint = 'consent_withdrawn';
  end if;
  select * into d from documents.items where id = p_kfs and offer_id = p_offer and borrower_id = v_borrower and document_type = 'kfs' for update;
  if not found then raise exception 'the KFS is not available for this offer' using errcode = '55000', hint = 'kfs_missing'; end if;
  if d.issuance_status <> 'issued' then raise exception 'the KFS is not current' using errcode = '55000', hint = 'kfs_not_current'; end if;
  if d.kfs_valid_until <= now() then raise exception 'the KFS validity has ended' using errcode = '55000', hint = 'kfs_expired'; end if;
  select * into k from documents.acknowledgements where id = p_ack and document_id = p_kfs and borrower_id = v_borrower;
  if not found or k.document_sha256 <> d.sha256 or k.offer_id <> p_offer then
    raise exception 'the KFS has not been acknowledged' using errcode = '55000', hint = 'acknowledgement_required';
  end if;
  if k.template_id is distinct from d.template_id or k.rule_id is distinct from d.rule_id then
    raise exception 'document versions are inconsistent' using errcode = '55000', hint = 'versions_inconsistent';
  end if;
  if exists (select 1 from lending.applications x where x.loan_request_id = a.loan_request_id and x.id <> a.id
              and x.status in ('offer_accepted', 'agreement_pending', 'agreement_executed', 'disbursement_pending', 'disbursed')) then
    raise exception 'another offer for this request was already accepted' using errcode = '55000', hint = 'another_offer_accepted';
  end if;
  -- Bound to THIS offer revision: a code verified for another offer or revision cannot be used here.
  v_step := identity.stepup_consume('offer_acceptance', p_offer::text);
  update lending.offers set status = 'accepted' where id = p_offer;
  perform set_config('udofin.transition_reason', 'offer_accepted', true);
  begin
    update lending.applications set status = 'offer_accepted' where id = a.id and status = 'approved';
  exception when unique_violation or raise_exception then
    if sqlstate = 'P0001' and sqlerrm not like '%already been accepted%' then raise; end if;
    raise exception 'another offer for this request was already accepted' using errcode = '55000', hint = 'another_offer_accepted';
  end;
  insert into documents.acceptances (borrower_id, lender_org_id, application_id, offer_id, offer_revision, kfs_document_id, kfs_sha256, acknowledgement_id,
    stepup_challenge_id, idempotency_ref)
  values (v_borrower, a.lender_org_id, a.id, p_offer, o.revision, p_kfs, d.sha256, p_ack, v_step, left(p_idem, 100))
  returning id into v_id;
  perform private.doc_event(p_kfs, d.lender_org_id, 'offer_accepted', jsonb_build_object('acceptanceId', v_id));
  perform lending.audit_event('documents.offer.accepted', 'offer', p_offer::text, jsonb_build_object('revision', o.revision));
  -- Agreement generation is a separate step; if it cannot run (no approved template, etc.) the acceptance stands and the state says so.
  insert into documents.generation_jobs (lender_org_id, application_id, offer_id, document_type, language, kfs_input_id, requested_by_actor)
  values (a.lender_org_id, a.id, p_offer, 'loan_agreement', d.language, d.kfs_input_id, 'system')
  on conflict (offer_id, document_type, language, kfs_input_id) where status in ('pending', 'running', 'failed') do nothing;
  perform ops.enqueue_event('document.generate', jsonb_build_object('job_id', (select j.id from documents.generation_jobs j
      where j.offer_id = p_offer and j.document_type = 'loan_agreement' and j.language = d.language and j.kfs_input_id = d.kfs_input_id
      order by j.created_at desc, j.id desc limit 1)),
    null, 'docgen-agreement:' || p_offer::text);
  return jsonb_build_object('acceptanceId', v_id, 'acceptedAt', now(), 'applicationStatus', 'offer_accepted', 'signatureStatus', 'not_signed',
                            'disbursementStatus', 'not_started', 'replayed', false);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Electronic signature boundary
-- ---------------------------------------------------------------------------------------------
create or replace function documents.start_signing(p_doc uuid, p_provider_key text, p_provider_mode text, p_idem text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  d documents.items;
  a lending.applications;
  v_existing documents.signing_requests;
  v_step uuid;
  v_id uuid;
begin
  select * into d from documents.items where id = p_doc and borrower_id = v_borrower and document_type = 'loan_agreement' for update;
  if not found then raise exception 'document not found' using errcode = 'P0002'; end if;
  select * into v_existing from documents.signing_requests where document_id = p_doc
     and state in ('awaiting_initiation', 'ready_for_signing', 'initiated', 'awaiting_borrower', 'requires_reconciliation', 'executed');
  if v_existing.id is not null then
    return jsonb_build_object('requestId', v_existing.id, 'state', v_existing.state, 'replayed', true);
  end if;
  if p_provider_mode = 'mock' then
    if coalesce(current_setting('udofin.allow_mock_signing', true), '') <> 'on' then
      raise exception 'the test signing adapter is not allowed here' using errcode = '42501', hint = 'mock_signing_blocked';
    end if;
  elsif p_provider_mode in ('sandbox', 'live') then
    if not coalesce((select s.bool_value from onboarding.platform_settings s where s.key = 'esign_provider_approved'), false) then
      raise exception 'no signing provider is approved' using errcode = '55000', hint = 'signing_not_available';
    end if;
  else
    raise exception 'signing is not available' using errcode = '55000', hint = 'signing_not_available';
  end if;
  if d.issuance_status <> 'issued' then raise exception 'the agreement is not current' using errcode = '55000', hint = 'agreement_not_current'; end if;
  select * into a from lending.applications where id = d.application_id;
  if a.status <> 'agreement_pending' then raise exception 'the agreement cannot be signed now' using errcode = '55000', hint = 'agreement_not_pending'; end if;
  if not private.lender_consent_ok(v_borrower, d.lender_org_id, a.loan_request_id) then
    raise exception 'consent for this lender is no longer in force' using errcode = '55000', hint = 'consent_withdrawn';
  end if;
  -- An OTP is required to start, bound to this agreement. It is not the signature.
  v_step := identity.stepup_consume('esign', p_doc::text);
  insert into documents.signing_requests (lender_org_id, application_id, borrower_id, document_id, document_sha256, state, provider_key, provider_mode,
    stepup_challenge_id, idempotency_ref)
  values (d.lender_org_id, d.application_id, v_borrower, p_doc, d.sha256, 'ready_for_signing', p_provider_key, p_provider_mode, v_step, left(p_idem, 100))
  returning id into v_id;
  insert into documents.signing_events (request_id, from_state, to_state) values (v_id, null, 'ready_for_signing');
  perform ops.enqueue_event('signing.initiate', jsonb_build_object('request_id', v_id), null, 'sign:' || v_id::text);
  perform private.doc_event(p_doc, d.lender_org_id, 'signing_requested', jsonb_build_object('requestId', v_id, 'mode', p_provider_mode));
  perform lending.audit_event('documents.signing.requested', 'document', p_doc::text, jsonb_build_object('mode', p_provider_mode));
  return jsonb_build_object('requestId', v_id, 'state', 'ready_for_signing', 'replayed', false);
end
$$;

create or replace function documents.signing_context(p_request uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s documents.signing_requests;
  d documents.items;
begin
  if private.invoking_role() <> 'service_role' then raise exception 'system only' using errcode = '42501'; end if;
  select * into s from documents.signing_requests where id = p_request;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into d from documents.items where id = s.document_id;
  return jsonb_build_object('requestId', s.id, 'state', s.state, 'providerKey', s.provider_key, 'providerMode', s.provider_mode, 'providerRef', s.provider_ref,
                            'documentId', d.id, 'documentSha256', s.document_sha256, 'storageKey', d.storage_key, 'uncertainSince', s.uncertain_since);
end
$$;

-- Only a provider's reported result (a verified callback or a status lookup) moves a request forward.
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
    if a.status = 'agreement_pending' then
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

-- ---------------------------------------------------------------------------------------------
-- Delivery of a content-free notice. Provider acceptance is never recorded as delivery.
-- ---------------------------------------------------------------------------------------------
create or replace function documents.request_delivery(p_doc uuid, p_channel text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  d documents.items;
  v_id uuid;
begin
  if p_channel not in ('sms_notice', 'email_notice') then raise exception 'invalid channel' using errcode = '22023'; end if;
  select * into d from documents.items where id = p_doc and borrower_id = v_borrower and issuance_status = 'issued';
  if not found then raise exception 'document not found' using errcode = 'P0002'; end if;
  if p_channel = 'email_notice' then
    -- Udofin holds no verified email address (D-59): never pretend to send.
    insert into documents.deliveries (document_id, borrower_id, lender_org_id, channel, status, failure_class)
    values (p_doc, v_borrower, d.lender_org_id, p_channel, 'not_configured', 'no_verified_destination') returning id into v_id;
    return jsonb_build_object('deliveryId', v_id, 'status', 'not_configured');
  end if;
  select id into v_id from documents.deliveries where document_id = p_doc and channel = p_channel and status in ('requested', 'accepted_by_provider', 'delivered');
  if v_id is not null then return jsonb_build_object('deliveryId', v_id, 'status', 'requested', 'replayed', true); end if;
  insert into documents.deliveries (document_id, borrower_id, lender_org_id, channel, status, attempt)
  values (p_doc, v_borrower, d.lender_org_id, p_channel, 'requested', coalesce((select max(attempt) + 1 from documents.deliveries where document_id = p_doc and channel = p_channel), 1))
  returning id into v_id;
  perform ops.enqueue_event('document.deliver', jsonb_build_object('delivery_id', v_id), null, 'deliver:' || v_id::text);
  perform lending.audit_event('documents.delivery.requested', 'document', p_doc::text, jsonb_build_object('channel', p_channel));
  return jsonb_build_object('deliveryId', v_id, 'status', 'requested');
end
$$;

-- Reads the phone number only at send time, like the lender transmission; it is never stored here.
create or replace function documents.begin_delivery(p_delivery uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  dl documents.deliveries;
  d documents.items;
  b identity.borrowers;
  v_phone text;
begin
  if private.invoking_role() <> 'service_role' then raise exception 'system only' using errcode = '42501'; end if;
  select * into dl from documents.deliveries where id = p_delivery for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if dl.status <> 'requested' then return jsonb_build_object('skip', dl.status); end if;
  select * into d from documents.items where id = dl.document_id;
  select * into b from identity.borrowers where id = dl.borrower_id;
  if d.issuance_status <> 'issued' or b.status <> 'active' then
    update documents.deliveries set status = 'failed', failure_class = 'document_not_current', updated_at = now() where id = p_delivery;
    return jsonb_build_object('skip', 'failed');
  end if;
  select u.phone into v_phone from auth.users u where u.id = b.user_id;
  if v_phone is null then
    update documents.deliveries set status = 'failed', failure_class = 'no_verified_destination', updated_at = now() where id = p_delivery;
    return jsonb_build_object('skip', 'failed');
  end if;
  return jsonb_build_object('deliveryId', p_delivery, 'channel', dl.channel, 'phone', v_phone, 'language', b.preferred_language);
end
$$;

create or replace function documents.record_delivery_result(p_delivery uuid, p_outcome text, p_provider_ref text, p_failure_class text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.invoking_role() <> 'service_role' then raise exception 'system only' using errcode = '42501'; end if;
  if p_outcome not in ('accepted_by_provider', 'delivered', 'failed', 'not_configured') then raise exception 'invalid outcome' using errcode = '22023'; end if;
  update documents.deliveries set status = p_outcome, provider_ref = left(p_provider_ref, 100),
    failure_class = case when p_outcome in ('failed', 'not_configured') then left(regexp_replace(coalesce(p_failure_class, 'unknown'), '[^a-z_]', '', 'g'), 50) end,
    updated_at = now()
   where id = p_delivery and status in ('requested', 'accepted_by_provider');
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'documents.open_document(uuid, text)', 'documents.application_documents(uuid)', 'documents.kfs_view(uuid, text)',
    'documents.acknowledge(uuid, uuid, text[], text, text, text, text, text)', 'documents.accept_offer(uuid, uuid, uuid, text)',
    'documents.start_signing(uuid, text, text, text)', 'documents.request_delivery(uuid, text)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['documents.signing_context(uuid)', 'documents.record_signing_event(uuid, text, text, text, jsonb)',
                           'documents.begin_delivery(uuid)', 'documents.record_delivery_result(uuid, text, text, text)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;
