-- =============================================================================================
-- Remediation of the database findings in the Phase 01 audit and the Phase 02 architecture review
-- (docs/audits/phase-01-repository-baseline-audit.md, docs/architecture/phase-02-architecture-verification.md).
-- Forward-only. No data is migrated: no payment, loan-account or proposal data exists yet. The indexes are created
-- without CONCURRENTLY because every table involved is empty at this point; do not reuse this pattern on a populated
-- database.
--
--   1. R-01  A payment intent can become 'succeeded' only on a signature-verified provider event for THAT intent,
--            lender and provider, whose normalised status is on an explicit success list and whose amount equals the
--            intent's amount. provider_events.amount_minor gets a range check.
--   2. R-05  servicing.loan_account_events: append-only history of status and disbursement changes of a loan account
--            (what the lender's LMS reported and when), written by a trigger.
--   3. FK indexes  Indexes for foreign keys on tables that are large, sit in tenant or RLS predicates, or are
--            touched by the borrower deletion path. The foreign keys deliberately left unindexed are listed below and
--            asserted EXACTLY by supabase/tests/013_remediation_db.test.sql, so a new foreign key without an index
--            fails CI until it is indexed or consciously added to that list.
--   4. Phase 07 leftovers  proposal numbers are unique per lender, not globally; a repeated e-mail notice request is
--            idempotent; a template body without an engine is refused; documents.kfs_view returns only the fields of
--            the validated KFS schema.
--   5. Outbox operations  ops.requeue_dead_event(id, actor) with an audit record, and ops.outbox_health().
--   6. Phase 06 follow-up  withdrawing consent against retired wording was still refused by the insert trigger on
--            consent.records (found by the new pgTAP test of the Phase 06 security review item 2).
--
-- ---------------------------------------------------------------------------------------------
-- Foreign keys deliberately left WITHOUT a supporting index (domain schemas), and why.
-- "Supported" means a valid, non-partial index whose leading columns are the key columns; for a composite key
-- (id, lender_org_id) an index led by the parent's id also counts, because the id alone identifies the parent row.
-- A partial index "where <key column> is not null" counts for a single-column key.
--
--   a. Actor-attribution columns referencing auth.users (created_by, approved_by, decided_by, recorded_by,
--      verified_by, actor_id, ...; ON DELETE NO ACTION). They are never used in a predicate, and auth.users rows are
--      not deleted while referenced (the constraint refuses it). Deleting an identity is a rare, planned operation
--      for which a sequential scan of these small tables is acceptable. The rule is encoded in the test, so
--      a new "*_by" column is exempt but a new user_id-style key is not.
--   b. Parents that are never deleted, so the key is never probed on a parent delete and no query joins on it:
--      reference and configuration rows (document types, categories, applicability rules, templates, calendars,
--      requirement templates), versioned or append-only rows (consent notices and records, product versions, matching
--      rule versions, comparison runs, selection items, KFS inputs, acknowledgements, documents.items) and
--      onboarding evidence (onboarding.documents, services, integrations, requirements). Every one of these
--      parents has a delete-blocking trigger or no code path that deletes it.
--        consent.records(notice_id)
--        documents.acceptances(acknowledgement_id)
--        documents.acknowledgements(rule_id), (template_id), (wording_notice_id)
--        documents.applicability_rules(document_type)
--        documents.generation_jobs(document_type), (template_id), (kfs_input_id, offer_id)
--        documents.items(document_type), (kfs_calendar_id), (kfs_input_id, offer_id), (rule_id), (template_id),
--                        (supersedes_id), (superseded_by_id)
--        documents.templates(document_type)
--        lending.application_routing(consent_record_id), (selection_item_id)
--        lending.comparison_runs(rule_version_id)
--        lending.lender_selection_items(consent_record_id), (product_version_id, lender_org_id)
--        lending.loan_requests(category_key), (product_version_id)
--        lending.matching_rule_proposals(resulting_version_id)
--        onboarding.accounting_profiles(evidence_document_id, lender_org_id)
--        onboarding.integrations(service_id, lender_org_id), (test_evidence_document_id, lender_org_id)
--        onboarding.lender_contracts(document_id, lender_org_id)
--        onboarding.lender_profiles(category_key), (verification_evidence_id, lender_org_id)
--        onboarding.lender_requirements(evidence_document_id, lender_org_id), (integration_id, lender_org_id),
--                                       (product_id, lender_org_id), (service_id, lender_org_id), (template_key)
--        onboarding.lender_services(category_key)
--        onboarding.requirement_dependencies(depends_on_id, lender_org_id)
--        onboarding.requirement_templates(applies_to_service_category)
--        onboarding.verification_history(evidence_document_id, lender_org_id)
--   c. tenancy.memberships(user_id): served on the hot path by the partial index memberships_user (active
--      memberships); organisations and identities are not deleted.
--   d. tenancy.roles(org_id): served by the partial unique index roles_org_key (org_id, key) where org_id is not null,
--      which the rule above accepts; listed here only because it is a cascade key.
--   e. lending.panel_views(lender_org_id): served for live (not archived) views by the partial indexes panel_views_lender
--      and panel_views_name; organisations are not deleted. The owner column, used by the RLS predicate, is indexed.
--
-- Everything else in the domain schemas has a supporting index after this migration.
-- =============================================================================================

-- 1. R-01: payment success needs a matching, verified, successful provider event ---------------------
-- The normalised provider statuses that count as money received. The ingest code (not built yet) must map a
-- provider's own vocabulary onto these before inserting an event; any other value (created, authorized, pending,
-- failed, refunded, ...) can never authorise success. Changing the list is a migration and an owner decision.
create or replace function private.payment_success_statuses()
returns text[]
language sql
immutable
set search_path = ''
as $$ select array['captured', 'paid', 'succeeded'] $$;
revoke all on function private.payment_success_statuses() from public;
grant execute on function private.payment_success_statuses() to authenticated, service_role;

-- A negative or absurd amount can never describe a payment; NULL stays allowed for events that carry no amount
-- (they simply can never authorise success). The table is empty, so the constraint is added and validated at once.
alter table payments.provider_events
  add constraint provider_events_amount_range check (amount_minor is null or (amount_minor >= 0 and amount_minor <= 100000000000000)) not valid;
alter table payments.provider_events validate constraint provider_events_amount_range;

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
    ) then
      raise exception 'a payment can be marked succeeded only after a signature-verified provider event with a success status and the same amount'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;

comment on column payments.provider_events.provider_status is
  'Normalised provider status. Only the values in private.payment_success_statuses() can authorise a payment intent to become succeeded.';

-- 2. R-05: history of loan-account changes ----------------------------------------------------------------
create table servicing.loan_account_events (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null,
  event_type text not null check (event_type in ('baseline', 'created', 'status_changed', 'disbursement_recorded', 'amount_changed')),
  old_status servicing.loan_status,
  new_status servicing.loan_status not null,
  old_sanctioned_amount_minor bigint check (old_sanctioned_amount_minor is null or old_sanctioned_amount_minor > 0),
  new_sanctioned_amount_minor bigint not null check (new_sanctioned_amount_minor > 0),
  old_disbursed_amount_minor bigint check (old_disbursed_amount_minor is null or old_disbursed_amount_minor > 0),
  new_disbursed_amount_minor bigint check (new_disbursed_amount_minor is null or new_disbursed_amount_minor > 0),
  old_disbursed_at timestamptz,
  new_disbursed_at timestamptz,
  old_disbursement_reference text,
  new_disbursement_reference text,
  source_system servicing.source_system not null,
  actor text not null check (actor in ('system', 'lender', 'platform', 'borrower', 'none', 'migration')),
  actor_user_id uuid,
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  check (event_type in ('baseline', 'created') or old_status is not null)
);
create index loan_account_events_account on servicing.loan_account_events (loan_account_id, occurred_at);
create index loan_account_events_lender on servicing.loan_account_events (lender_org_id, occurred_at);
comment on table servicing.loan_account_events is
  'Append-only history of what the lender''s LMS reported for a loan account: status, sanctioned and disbursed amounts, disbursement evidence, each with old and new value, actor and time. Written by a trigger on servicing.loan_accounts, never by a caller. Udofin does not own the loan record (ADR 0007); this is the immutable copy of changes it was told about. Owner: servicing module.';

create trigger loan_account_events_append_only before update or delete on servicing.loan_account_events
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.loan_account_events
  for each statement execute function private.forbid_truncate();

alter table servicing.loan_account_events enable row level security;
alter table servicing.loan_account_events force row level security;
-- Same visibility as the loan account itself (loan_accounts_borrower_read, loan_accounts_lender_read).
create policy loan_account_events_borrower_read on servicing.loan_account_events for select to authenticated
  using (loan_account_id in (select la.id from servicing.loan_accounts la where la.borrower_id = (select private.my_borrower_id())));
create policy loan_account_events_lender_read on servicing.loan_account_events for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('loan.read')));
grant select on servicing.loan_account_events to authenticated;

-- Runs after every insert or update of a loan account, whoever wrote it (the LMS sync runs as the system role,
-- which has no insert right on the history table). A write that changes none of the tracked fields (for example
-- only last_synced_at) leaves no row.
create or replace function private.record_loan_account_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
begin
  if tg_op = 'INSERT' then
    v_type := 'created';
  else
    if (new.status, new.sanctioned_amount_minor, new.disbursed_amount_minor, new.disbursed_at, new.disbursement_reference)
       is not distinct from (old.status, old.sanctioned_amount_minor, old.disbursed_amount_minor, old.disbursed_at, old.disbursement_reference) then
      return null;
    end if;
    v_type := case
      when new.status is distinct from old.status then 'status_changed'
      when (new.disbursed_amount_minor, new.disbursed_at, new.disbursement_reference)
           is distinct from (old.disbursed_amount_minor, old.disbursed_at, old.disbursement_reference) then 'disbursement_recorded'
      else 'amount_changed' end;
  end if;
  insert into servicing.loan_account_events (
    lender_org_id, loan_account_id, event_type, old_status, new_status,
    old_sanctioned_amount_minor, new_sanctioned_amount_minor, old_disbursed_amount_minor, new_disbursed_amount_minor,
    old_disbursed_at, new_disbursed_at, old_disbursement_reference, new_disbursement_reference,
    source_system, actor, actor_user_id)
  values (
    new.lender_org_id, new.id, v_type, case when tg_op = 'UPDATE' then old.status end, new.status,
    case when tg_op = 'UPDATE' then old.sanctioned_amount_minor end, new.sanctioned_amount_minor,
    case when tg_op = 'UPDATE' then old.disbursed_amount_minor end, new.disbursed_amount_minor,
    case when tg_op = 'UPDATE' then old.disbursed_at end, new.disbursed_at,
    case when tg_op = 'UPDATE' then old.disbursement_reference end, new.disbursement_reference,
    new.source_system, private.current_actor(), (select auth.uid()));
  return null;
end
$$;
revoke all on function private.record_loan_account_event() from public;
create trigger loan_accounts_record_event after insert or update on servicing.loan_accounts
  for each row execute function private.record_loan_account_event();

-- Loan accounts that already exist get one baseline row so the history starts from a known state.
insert into servicing.loan_account_events (
  lender_org_id, loan_account_id, event_type, new_status, new_sanctioned_amount_minor, new_disbursed_amount_minor, new_disbursed_at,
  new_disbursement_reference, source_system, actor, occurred_at)
select la.lender_org_id, la.id, 'baseline', la.status, la.sanctioned_amount_minor, la.disbursed_amount_minor, la.disbursed_at,
       la.disbursement_reference, la.source_system, 'migration', clock_timestamp()
from servicing.loan_accounts la;

-- 3. Foreign-key indexes ---------------------------------------------------------------------------------------
-- consent / identity (borrower deletion path deletes by borrower_id; RLS predicates use lender and borrower ids)
create index notices_lender_fk on consent.notices (lender_org_id);
create index deletion_requests_borrower_fk on identity.deletion_requests (borrower_id);
create index integrity_nonces_borrower_fk on identity.integrity_nonces (borrower_id);

-- lending (routing, comparison, offers)
create index comparison_nonoffers_lender_fk on lending.comparison_nonoffers (lender_org_id);
create index comparison_runs_request_fk on lending.comparison_runs (loan_request_id);
create index lender_selection_items_lender_fk on lending.lender_selection_items (lender_org_id);
create index lender_selections_request_fk on lending.lender_selections (loan_request_id);
create index loan_request_events_borrower_fk on lending.loan_request_events (borrower_id);
create index offer_displays_run_fk on lending.offer_displays (run_id);
create index offer_intake_offer_fk on lending.offer_intake (offer_id);
create index offers_supersedes_fk on lending.offers (supersedes_offer_id);
create index panel_views_owner_fk on lending.panel_views (owner_user_id);

-- documents
create index acceptances_borrower_fk on documents.acceptances (borrower_id);
create index acceptances_document_fk on documents.acceptances (kfs_document_id);
create index acceptances_stepup_fk on documents.acceptances (stepup_challenge_id);
create index access_log_lender_fk on documents.access_log (lender_org_id, accessed_at);
create index deliveries_document_fk on documents.deliveries (document_id, channel);
create index deliveries_borrower_fk on documents.deliveries (borrower_id);
create index deliveries_lender_fk on documents.deliveries (lender_org_id, requested_at);
create index generation_jobs_offer_fk on documents.generation_jobs (offer_id, lender_org_id);
create index item_events_lender_fk on documents.item_events (lender_org_id, occurred_at);
create index signing_events_request_fk on documents.signing_events (request_id, occurred_at);
create index signing_requests_borrower_fk on documents.signing_requests (borrower_id);
create index signing_requests_document_fk on documents.signing_requests (document_id, lender_org_id);
create index signing_requests_stepup_fk on documents.signing_requests (stepup_challenge_id);

-- tenancy and onboarding (tenant predicates)
create index lender_settlement_accounts_lender_fk on tenancy.lender_settlement_accounts (lender_org_id);
create index accounting_waivers_lender_fk on onboarding.accounting_waivers (lender_org_id);

-- 4. Phase 07 leftovers -----------------------------------------------------------------------------------------
-- 4a. Proposal numbers are unique per lender. A number another lender uses is accepted and never revealed; a clash
--     inside the same lender still raises proposal_no_taken. The unique index also supports the lender foreign key.
alter table documents.proposals drop constraint proposals_proposal_no_key;
alter table documents.proposals add constraint proposals_lender_proposal_no_key unique (lender_org_id, proposal_no);

create or replace function private.ensure_proposal(p_offer uuid, p_lender uuid, p_data jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v text;
begin
  select proposal_no into v from documents.proposals where offer_id = p_offer;
  if v is not null then return v; end if;
  if jsonb_typeof(p_data -> 'proposalNo') = 'string' then
    v := p_data ->> 'proposalNo';
    insert into documents.proposals (offer_id, lender_org_id, proposal_no, source) values (p_offer, p_lender, v, 'lender_supplied');
  else
    v := 'UDF-' || upper(replace(substr(gen_random_uuid()::text, 1, 13), '-', ''));
    insert into documents.proposals (offer_id, lender_org_id, proposal_no, source) values (p_offer, p_lender, v, 'udofin_allocated');
  end if;
  return v;
exception when unique_violation then
  -- Either a concurrent call already allocated a number for this offer (return it), or the number is already used
  -- by ANOTHER offer of the SAME lender. Uniqueness is per lender, so nothing about other lenders' numbers is
  -- ever learned from this error.
  select proposal_no into v from documents.proposals where offer_id = p_offer;
  if v is null then raise exception 'proposal number already in use' using errcode = '55000', hint = 'proposal_no_taken'; end if;
  return v;
end
$$;
revoke all on function private.ensure_proposal(uuid, uuid, jsonb) from public;

-- 4b. A repeated e-mail notice request returns the row that already exists. There is no verified e-mail address
--     (D-59), so each request used to add another not_configured row; now there is at most one per document. The SMS
--     path below is unchanged.
create unique index deliveries_email_notice_once on documents.deliveries (document_id) where channel = 'email_notice';

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
  v_status text;
  v_new boolean;
begin
  if p_channel not in ('sms_notice', 'email_notice') then raise exception 'invalid channel' using errcode = '22023'; end if;
  select * into d from documents.items where id = p_doc and borrower_id = v_borrower and issuance_status = 'issued';
  if not found then raise exception 'document not found' using errcode = 'P0002'; end if;
  if p_channel = 'email_notice' then
    -- Udofin holds no verified email address (D-59): never pretend to send. One row per document, however often asked.
    insert into documents.deliveries (document_id, borrower_id, lender_org_id, channel, status, failure_class)
    values (p_doc, v_borrower, d.lender_org_id, p_channel, 'not_configured', 'no_verified_destination')
    on conflict (document_id) where channel = 'email_notice' do nothing
    returning id into v_id;
    v_new := v_id is not null;
    if not v_new then
      select x.id, x.status into v_id, v_status from documents.deliveries x where x.document_id = p_doc and x.channel = 'email_notice';
      return jsonb_build_object('deliveryId', v_id, 'status', v_status, 'replayed', true);
    end if;
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

-- 4c. A template body without an engine made `p_body ->> 'engine' not in (...)` NULL, which is not true, so it was
--     stored. A missing, non-text or unknown engine is now refused.
create or replace function documents.propose_template(p_key text, p_type text, p_language text, p_lender uuid, p_body jsonb, p_sample boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_lender is null then
    perform private.assert_platform_documents();
  elsif p_lender in (select private.orgs_with_permission('document.prepare')) then
    perform private.require_aal2();
  elsif private.has_platform_permission('platform.documents.manage') then
    perform private.require_aal2();
  else
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if coalesce(p_body ->> 'engine', '') <> all (array['annex_i_v1', 'agreement_v1']) then
    raise exception 'unknown template engine' using errcode = '22023', hint = 'template_engine_unknown';
  end if;
  insert into documents.templates (template_key, document_type, language, lender_org_id, version, body, is_sample, status, created_by)
  values (p_key, p_type, p_language, p_lender,
          (select coalesce(max(version), 0) + 1 from documents.templates t
            where t.template_key = p_key and t.language = p_language and t.lender_org_id is not distinct from p_lender),
          p_body, coalesce(p_sample, false), 'in_review', (select auth.uid()))
  returning id into v_id;
  perform lending.audit_event('documents.template.proposed', 'template', v_id::text);
  return v_id;
end
$$;

-- 4e. documents.kfs_view returned the lender's stored JSON as it was, including any nested key that the structural
--     check does not inspect. It now returns only the fields of the validated kfs_data_v1 structure (the same set
--     packages/contracts KfsDataV1 declares), so extra lender text cannot reach the borrower.
create or replace function private.kfs_pick(p jsonb, p_keys text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p) = 'object'
    then coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(p) e where e.key = any (p_keys)), '{}'::jsonb)
    end
$$;

create or replace function private.kfs_pick_each(p jsonb, p_keys text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p) = 'array'
    then coalesce((select jsonb_agg(private.kfs_pick(e.value, p_keys) order by e.ord) from jsonb_array_elements(p) with ordinality e (value, ord)), '[]'::jsonb)
    end
$$;

create or replace function private.kfs_project(p jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p) = 'object' then jsonb_strip_nulls(
    private.kfs_pick(p, array['schema', 'proposalNo', 'loanType', 'borrowerNameAsPerLender', 'sanctionedAmountMinor', 'tenureDays', 'aprBps', 'noFees'])
    || jsonb_build_object(
      'disbursal', private.kfs_pick(p -> 'disbursal', array['mode', 'stagedClauseRef']),
      'loanTerm', private.kfs_pick(p -> 'loanTerm', array['value', 'unit']),
      'instalments', private.kfs_pick(p -> 'instalments', array['type', 'frequency', 'count', 'amountMinor', 'commencementDaysAfterSanction',
                                                                   'principalInstalments', 'capitalisedInterestInstalments']),
      'interest', private.kfs_pick(p -> 'interest', array['rateBps', 'type']),
      'floating', private.kfs_pick(p -> 'floating', array['referenceBenchmark', 'benchmarkRateBps', 'spreadBps', 'finalRateBps', 'resetPeriodicityMonths'])
                  || jsonb_build_object('impactOf25bps', private.kfs_pick(p #> '{floating,impactOf25bps}',
                       array['epiOnBenchmarkMinor', 'epiOnSpreadMinor', 'epiCountOnBenchmark', 'epiCountOnSpread'])),
      'fees', private.kfs_pick_each(p -> 'fees', array['category', 'label', 'payee', 'timing', 'frequency', 'amountMinor', 'percentBps']),
      'contingent', case when jsonb_typeof(p -> 'contingent') = 'object' then jsonb_build_object(
                         'penalDelayed', private.kfs_pick(p #> '{contingent,penalDelayed}', array['amountMinor', 'percentBps', 'text', 'notApplicable']),
                         'otherPenal', private.kfs_pick(p #> '{contingent,otherPenal}', array['amountMinor', 'percentBps', 'text', 'notApplicable']),
                         'foreclosure', private.kfs_pick(p #> '{contingent,foreclosure}', array['amountMinor', 'percentBps', 'text', 'notApplicable']),
                         'switching', private.kfs_pick(p #> '{contingent,switching}', array['amountMinor', 'percentBps', 'text', 'notApplicable']),
                         'other', private.kfs_pick_each(p #> '{contingent,other}', array['amountMinor', 'percentBps', 'text', 'notApplicable'])) end,
      'computation', private.kfs_pick(p -> 'computation', array['totalInterestMinor', 'feesTotalMinor', 'feesToLenderMinor', 'feesToThirdPartyMinor',
                                                                   'netDisbursedMinor', 'totalPayableMinor', 'scheduleOfDisbursement', 'roundingNote']),
      'schedule', private.kfs_pick_each(p -> 'schedule', array['no', 'dueDate', 'outstandingPrincipalMinor', 'principalMinor', 'interestMinor', 'instalmentMinor']),
      'part2', private.kfs_pick(p -> 'part2', array['recoveryAgentClauseRef', 'grievanceClauseRef', 'nodalOfficerPhone', 'nodalOfficerEmail', 'transferOrSecuritisation'])
               || jsonb_build_object(
                    'collaborativeLending', private.kfs_pick(p #> '{part2,collaborativeLending}',
                       array['originatingRe', 'originatingFundingPercentBps', 'partnerRe', 'partnerFundingPercentBps', 'blendedRateBps']),
                    'digital', private.kfs_pick(p #> '{part2,digital}', array['coolingOffDays', 'coolingOffNote', 'lspRecoveryAgent']))))
  end
$$;
revoke all on function private.kfs_pick(jsonb, text[]) from public;
revoke all on function private.kfs_pick_each(jsonb, text[]) from public;
revoke all on function private.kfs_project(jsonb) from public;
-- No grants: documents.kfs_view is SECURITY DEFINER and calls these as its owner; nobody else needs them.

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
    -- Only a generated KFS has structured data; an uploaded KFS is shown as the lender's file. Only the validated
    -- fields are returned, never the stored JSON as it was.
    'data', case when i.mode = 'data' then private.kfs_project(i.data) end,
    'ackSections', to_jsonb(coalesce(v_rule.ack_sections, '{}')),
    'wording', case when v_notice.id is null then null else jsonb_build_object(
        'noticeId', v_notice.id, 'version', v_notice.version, 'language', v_notice.language, 'title', v_notice.title, 'body', v_notice.body_markdown,
        'languageFallback', v_notice.language <> p_language) end,
    'acknowledged', v_ack.id is not null);
end
$$;

-- 5. Outbox operations ------------------------------------------------------------------------------------------
-- Replays a dead event. The audit record carries the event id, type, previous attempts and error code and the
-- named operator, never the payload. last_error_code is kept until the event next succeeds, so the cause stays
-- visible on the row as well. Refuses anything that is not dead.
create or replace function ops.requeue_dead_event(p_id uuid, p_actor text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e ops.outbox_events;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'system only' using errcode = '42501';
  end if;
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._:-]{1,80}$' then
    raise exception 'an operator identifier is required (letters, digits and . _ : - only; no e-mail address)' using errcode = '22023';
  end if;
  select * into v_e from ops.outbox_events e where e.id = p_id and e.status = 'dead' for update;
  if not found then
    return false;
  end if;
  update ops.outbox_events e
  set status = 'pending', attempts = 0, available_at = now(), locked_by = null, locked_until = null
  where e.id = p_id;
  insert into audit.events (actor_type, action, entity_type, entity_id, metadata)
  values ('system', 'ops.outbox.requeued', 'outbox_event', p_id::text,
          jsonb_build_object('operator', p_actor, 'event_type', v_e.event_type, 'previous_attempts', v_e.attempts, 'previous_error_code', v_e.last_error_code));
  return true;
end
$$;
revoke all on function ops.requeue_dead_event(uuid, text) from public, anon, authenticated;
grant execute on function ops.requeue_dead_event(uuid, text) to service_role;
comment on function ops.requeue_dead_event(uuid, text) is
  'Replays a dead outbox event after the cause is fixed and writes an audit record (operator, event type, previous attempts and error code; no payload). Returns false for an event that is not dead. Runbook: docs/api/idempotency-and-outbox.md.';

-- The earlier one-argument form is kept as a thin wrapper so existing callers keep working, but it now leaves the same
-- audit record (operator "unspecified"). Prefer the two-argument form; remove this one when no caller remains.
create or replace function ops.requeue_dead_event(p_id uuid)
returns boolean
language sql
set search_path = ''
as $$ select ops.requeue_dead_event(p_id, 'unspecified') $$;

-- Counts and ages for monitoring and alerts. Contains no payloads and no identifiers.
create or replace function ops.outbox_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pending bigint;
  v_processing bigint;
  v_completed bigint;
  v_dead bigint;
  v_expired bigint;
  v_oldest timestamptz;
  v_oldest_dead timestamptz;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'system only' using errcode = '42501';
  end if;
  select count(*) filter (where status = 'pending'), count(*) filter (where status = 'processing'),
         count(*) filter (where status = 'completed'), count(*) filter (where status = 'dead'),
         count(*) filter (where status = 'processing' and locked_until < now()),
         min(available_at) filter (where status = 'pending' and available_at <= now()),
         min(updated_at) filter (where status = 'dead')
    into v_pending, v_processing, v_completed, v_dead, v_expired, v_oldest, v_oldest_dead
  from ops.outbox_events;
  return jsonb_build_object(
    'byStatus', jsonb_build_object('pending', v_pending, 'processing', v_processing, 'completed', v_completed, 'dead', v_dead),
    -- How long the oldest event that is ready to run (not one waiting for its retry time) has been waiting.
    'oldestPendingAgeSeconds', case when v_oldest is null then null else floor(extract(epoch from now() - v_oldest)) end,
    'deadCount', v_dead,
    'oldestDeadAgeSeconds', case when v_oldest_dead is null then null else floor(extract(epoch from now() - v_oldest_dead)) end,
    'expiredLeases', v_expired,
    'checkedAt', now());
end
$$;
revoke all on function ops.outbox_health() from public, anon, authenticated;
grant execute on function ops.outbox_health() to service_role;
comment on function ops.outbox_health() is
  'Outbox counts by status, age of the oldest ready pending event, number and age of dead events, and expired leases. System role only. For alerting; contains no payloads.';

-- 6. Consent withdrawal must stay possible after the wording is retired ------------------------------------------
-- consent.record_lender_decision already looked up a retired notice for a withdrawal (Phase 06 review, finding 2), but
-- the insert trigger on consent.records then refused it ("consent must reference a published notice"), so a borrower
-- could not withdraw consent once Udofin or a lender retired the wording. Granting still needs the published wording;
-- a withdrawal may reference a published or a retired notice (never a draft). Everything else is unchanged.
create or replace function private.check_consent_notice_published()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_notice consent.notices;
begin
  -- The server's clock, never the caller's, decides when consent was captured.
  new.captured_at := now();
  select n.* into v_notice from consent.notices n where n.id = new.notice_id;
  if v_notice.id is null
     or not (v_notice.status = 'published' or (new.decision = 'withdrawn' and v_notice.status = 'retired')) then
    raise exception 'consent must reference a published notice' using errcode = '23514';
  end if;
  if v_notice.lender_org_id is not null and new.lender_org_id is distinct from v_notice.lender_org_id then
    raise exception 'a lender-specific notice can only authorise that lender' using errcode = '23514';
  end if;
  if new.lender_org_id is not null and not exists (
    select 1 from tenancy.organizations o where o.id = new.lender_org_id and o.kind = 'lender'
  ) then
    raise exception 'lender_org_id must reference a lender organisation' using errcode = '23514';
  end if;
  return new;
end
$$;
