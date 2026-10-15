-- =============================================================================================
-- Phase 08a, lender-issued documents, foreclosure quotes and closure (stream LENDER-ISSUED DOCUMENTS, QUOTES, CLOSURE).
-- Spec: docs/specs/08-servicing-payments-mandates-collections.md sections 5, 12, 15, 18, 21 (Statements/NOC/closure) and the
-- owner decisions of 14 October 2026.
--
-- What this migration does
--   1. Draft applicability rules (platform data, never seeded approved): servicing.noc_sla_days_default,
--      servicing.statement_sla_days_default (PLATFORM settings, not regulatory claims) and servicing.security_release_sla_days
--      (RBC paras 35 to 36, confirmed in text for the cases it covers). Three lender-issued document types are added to the
--      Phase 07 catalogue. Due dates are read from an APPROVED rule; with none, the due date is empty (rule unresolved).
--   2. servicing.document_requests   a borrower asks for a statement, foreclosure quote, NOC or closure letter on their own loan.
--   3. servicing.loan_documents      append-only registry of LENDER-ISSUED PDFs (opaque storage key, SHA-256, lender reference).
--      The issuer can only be 'lender'. Udofin generates and renders nothing. servicing.loan_document_access is the access log.
--   4. servicing.foreclosure_quotes  append-only quotations as the lender REPORTED them. A mismatch between the parts and the
--      total is FLAGGED in a generated column, never corrected. servicing.latest_valid_quote returns the newest unexpired quote.
--   5. servicing.closure_records / servicing.security_release_tasks  opened by a trigger when a loan becomes closed or
--      foreclosed (once per loan, one outbox event with ids only). Udofin holds no collateral: only a lender user holding
--      servicing.document.issue, with a confirmation reference, can move a task to confirmed_by_lender.
--
-- Fail closed: every write path needs the lender's statements_noc switch (private.require_feature), the named permission and
-- aal2 for people. Borrowers have NO direct table access: they read through SECURITY DEFINER functions, which also hide the
-- feature when the switch is off. Lenders read their own rows through forced RLS (loan.read). Nothing here moves money.
-- A mock or sandbox source is refused unless the session allows mock providers (foundation guard pattern) and is ignored
-- by latest_valid_quote and the document lists otherwise.
--
-- Forward-only. No new enum values. Error convention: SQLSTATE and hint. 42501 not authorised, P0002 not found,
-- 22023 bad input, 55000 rule or state, 23505 duplicate.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- A. Rule seeds (draft) and the lender-issued document types
-- ---------------------------------------------------------------------------------------------
alter table documents.document_types drop constraint document_types_data_source_check;
alter table documents.document_types add constraint document_types_data_source_check
  check (data_source in ('kfs_data', 'kfs_data_and_template', 'lender_template', 'lender_issued'));
insert into documents.document_types (key, description, data_source) values
  ('statement_of_account', 'Statement of account issued by the lender. Udofin renders no statement.', 'lender_issued'),
  ('noc', 'No-dues certificate, NOC or closure letter issued by the lender', 'lender_issued'),
  ('security_release', 'Release of security (lien, pledge, hypothecation, property documents) by the lender, who alone confirms it', 'lender_issued');

insert into documents.applicability_rules (rule_key, version, lender_category_keys, regulator, direction_ref, paragraph_refs, product_category_keys,
  exclusions, document_type, required_template_key, required_fields_version, required_acknowledgements, ack_sections, validity_rule, language_policy,
  effective_from, approval_status, evidence_status)
values
  ('servicing.noc_sla_days_default', 1, array['nbfc_icc', 'nbfc_d'], 'Udofin platform setting (not a regulator)',
   'Platform default for tracking the lender''s no-dues certificate / NOC (spec 08 section 12.3, decision D-74). NOT a regulatory deadline: no RBI timeline for an NOC on an unsecured loan was found in the texts on file.',
   '{}',
   array['personal', 'loan_against_securities', 'vehicle', 'home', 'loan_against_property', 'medical', 'legal_expense', 'resolution_finance', 'debt_reset'],
   'DRAFT. PLATFORM SETTING, NOT A REGULATORY CLAIM. Evidence label: unverified (no source sets an NOC or no-dues timeline for unsecured loans; spec 08 section 3.2). The 30 days is the spec''s recommended default and needs the owner''s confirmation. The clock starts when Udofin recorded the closure, not when the borrower repaid.',
   'noc', 'none.lender_issued', 'none', '{}', '{}',
   '{"kind":"calendar_days","days":30,"basis":"closure_recorded","label":"platform_default"}'::jsonb, '{}'::jsonb,
   date '2026-10-14', 'draft', 'unverified'),
  ('servicing.statement_sla_days_default', 1, array['nbfc_icc', 'nbfc_d'], 'Udofin platform setting (not a regulator)',
   'Platform default for the lender to answer a borrower''s statement-of-account request (spec 08 section 12.1, decision D-74). NOT a regulatory deadline: the periodic statement frequency and any response time are not stated in the texts on file.',
   '{}',
   array['personal', 'loan_against_securities', 'vehicle', 'home', 'loan_against_property', 'medical', 'legal_expense', 'resolution_finance', 'debt_reset'],
   'DRAFT. PLATFORM SETTING, NOT A REGULATORY CLAIM. Evidence label: unverified. The figure of 7 days is a PROPOSED operational target with no source; the owner must confirm or replace it before approval.',
   'statement_of_account', 'none.lender_issued', 'none', '{}', '{}',
   '{"kind":"calendar_days","days":7,"basis":"request_received","label":"platform_default_proposed"}'::jsonb, '{}'::jsonb,
   date '2026-10-14', 'draft', 'unverified'),
  ('servicing.security_release_sla_days', 1, array['nbfc_icc', 'nbfc_d'], 'RBI',
   'RBC Directions 2025 (RBI/DOR/2025-26/362, DOR.MCS.REC.No.281/01-01-039/2025-26), text updated as on 1 April 2026',
   array['35', '36'],
   array['loan_against_securities', 'vehicle', 'home', 'loan_against_property', 'personal'],
   'DRAFT FOR LEGAL/COMPLIANCE REVIEW. Evidence label: confirmed in text for the cases paras 35 to 36 cover (original movable or immovable property documents released and registry charges removed within 30 days after full repayment or settlement; applies to Personal Loans as defined by para 6(11), a cross-reference that was not read). The release is the LENDER''s duty and exposure (paras 39 to 41); Udofin holds no collateral and only tracks it. Udofin measures the 30 days from the time it recorded the closure, which is a tracker, not the legal clock. Banks, UCBs and HFCs are not covered (their texts are not on file).',
   'security_release', 'none.lender_issued', 'none', '{}', '{}',
   '{"kind":"calendar_days","days":30,"basis":"closure_recorded","label":"rbi_rbc_35_36"}'::jsonb, '{}'::jsonb,
   date '2025-11-28', 'draft', 'confirmed');

-- ---------------------------------------------------------------------------------------------
-- B. Small helpers (no grants: only SECURITY DEFINER functions of this migration call them)
-- ---------------------------------------------------------------------------------------------
-- Free text a lender may enter (a note, a delay reason): no e-mail, no run of 8 or more digits, no PAN-shaped token.
-- Defence in depth only; it is not a personal-data scanner.
create or replace function private.servicing_text_safe(p_text text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$ select p_text !~ '[0-9]{8,}' and p_text !~ '@' and p_text !~ '[A-Z]{5}[0-9]{4}[A-Z]' $$;
revoke all on function private.servicing_text_safe(text) from public;
grant execute on function private.servicing_text_safe(text) to authenticated, service_role;

create or replace function private.servicing_ist_today()
returns date
language sql
stable
set search_path = ''
as $$ select (clock_timestamp() at time zone 'Asia/Kolkata')::date $$;
revoke all on function private.servicing_ist_today() from public;

-- Audit through the existing path: a signed-in person through private.record_audit_event (actor derived from the session),
-- the system role as a system event. Metadata holds identifiers and codes only.
create or replace function private.servicing_docs_audit(p_tenant uuid, p_action text, p_entity_type text, p_entity_id text, p_meta jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    perform private.record_audit_event(p_action, p_entity_type, p_entity_id, p_tenant, 'success', coalesce(p_meta, '{}'::jsonb));
  else
    insert into audit.events (actor_type, tenant_org_id, action, entity_type, entity_id, outcome, metadata)
    values ('system', p_tenant, p_action, p_entity_type, p_entity_id, 'success', coalesce(p_meta, '{}'::jsonb));
  end if;
end
$$;
revoke all on function private.servicing_docs_audit(uuid, text, text, text, jsonb) from public;

-- Who may act for a lender. The system role only where p_allow_system; a person needs the permission in that lender (a person who
-- cannot even read the lender's loans gets "not found", so another lender's ids are not an oracle) and aal2. Returns the user id
-- (null for the system).
create or replace function private.servicing_docs_actor(p_lender uuid, p_permission text, p_allow_system boolean)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if private.invoking_role() = 'service_role' then
    if p_allow_system then return null; end if;
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if v_uid is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if not coalesce(p_lender in (select private.orgs_with_permission(p_permission)), false) then
    if coalesce(p_lender in (select private.orgs_with_permission('loan.read')), false) then
      raise exception 'not authorised' using errcode = '42501';
    end if;
    raise exception 'not found' using errcode = 'P0002';
  end if;
  perform private.require_aal2();
  return v_uid;
end
$$;
revoke all on function private.servicing_docs_actor(uuid, text, boolean) from public;

-- The loan of the signed-in borrower, or "not found".
create or replace function private.servicing_docs_borrower_loan(p_loan uuid)
returns servicing.loan_accounts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
  v_borrower uuid := private.my_borrower_id();
begin
  if v_borrower is null or p_loan is null then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  select * into l from servicing.loan_accounts la where la.id = p_loan and la.borrower_id = v_borrower;
  if not found then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  return l;
end
$$;
revoke all on function private.servicing_docs_borrower_loan(uuid) from public;

-- Product category of the loan (from the borrower's loan request that the application came from).
create or replace function private.servicing_loan_category(p_loan uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lr.category_key
  from servicing.loan_accounts la
  join lending.applications a on a.id = la.application_id
  join lending.loan_requests lr on lr.id = a.loan_request_id
  where la.id = p_loan
$$;
revoke all on function private.servicing_loan_category(uuid) from public;

-- Resolves a calendar-day period from an APPROVED, effective applicability rule for the lender's category (and the product
-- category, unless p_product_category is null). No row = unresolved (a draft rule is never used). Fail closed: a rule whose
-- validity_rule is not {"kind":"calendar_days","days":n} with n between 1 and 9999 does not resolve. When the highest approved
-- version is malformed, nothing resolves (no fallback to an older version).
create or replace function private.servicing_rule_days(p_lender uuid, p_rule_key text, p_product_category text, p_on date)
returns table (rule_id uuid, days integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cat text;
  r documents.applicability_rules;
begin
  select lp.category_key into v_cat from onboarding.lender_profiles lp where lp.lender_org_id = p_lender;
  if v_cat is null then return; end if;
  select x.* into r from documents.applicability_rules x
   where x.rule_key = p_rule_key and x.approval_status = 'approved'
     and v_cat = any (x.lender_category_keys)
     and (p_product_category is null or p_product_category = any (x.product_category_keys))
     and x.effective_from <= p_on and (x.effective_to is null or x.effective_to >= p_on)
   order by x.version desc
   limit 1;
  if not found then return; end if;
  if r.validity_rule ->> 'kind' is distinct from 'calendar_days' or coalesce(r.validity_rule ->> 'days', '') !~ '^[1-9][0-9]{0,3}$' then
    return;
  end if;
  return query select r.id, (r.validity_rule ->> 'days')::integer;
end
$$;
revoke all on function private.servicing_rule_days(uuid, text, text, date) from public;

-- ---------------------------------------------------------------------------------------------
-- C. Tables
-- ---------------------------------------------------------------------------------------------
create table servicing.loan_documents (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null,
  kind text not null check (kind in ('statement', 'foreclosure_quote', 'noc', 'closure_letter')),
  -- Udofin can never be the issuer: the lender issues, Udofin stores and delivers.
  issuer text not null default 'lender' check (issuer = 'lender'),
  -- The lender's own document number.
  lender_reference text not null check (lender_reference ~ '^[A-Za-z0-9._/-]{1,100}$'),
  issued_at timestamptz not null check (issued_at >= timestamptz '2000-01-01 00:00:00+00'),
  received_at timestamptz not null default clock_timestamp(),
  period_from date,
  period_to date,
  -- Opaque key in the private document store (no personal data in it); there is no public URL. No role can select this column.
  storage_key text not null unique check (storage_key ~ '^servicing/[A-Za-z0-9/_-]{8,180}$'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  mime_type text not null default 'application/pdf' check (mime_type = 'application/pdf'),
  supersedes_id uuid,
  source text not null check (source in ('lender_upload', 'lms', 'mock')),
  uploaded_by uuid references auth.users (id),
  unique (id, lender_org_id),
  unique (id, loan_account_id),
  unique (loan_account_id, kind, lender_reference),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  foreign key (supersedes_id, loan_account_id) references servicing.loan_documents (id, loan_account_id) on delete restrict,
  constraint statement_has_period check ((kind = 'statement') = (period_from is not null and period_to is not null)),
  constraint period_order check (period_to is null or period_from is null or period_to >= period_from),
  constraint not_self_superseding check (supersedes_id is null or supersedes_id <> id),
  constraint upload_is_attributed check (source <> 'lender_upload' or uploaded_by is not null)
);
create index loan_documents_loan on servicing.loan_documents (loan_account_id, kind, issued_at desc);
create index loan_documents_lender on servicing.loan_documents (lender_org_id, issued_at desc);
-- A document is superseded at most once; the full (non-partial) index also serves the composite foreign key.
create unique index loan_documents_supersedes on servicing.loan_documents (supersedes_id, loan_account_id);
comment on table servicing.loan_documents is
  'Registry of documents ISSUED BY THE LENDER about a loan (statement of account, foreclosure quotation letter, no-dues/NOC, closure letter): opaque private-store key, SHA-256, size, lender reference, lender issue time, statement period, supersession. issuer is always ''lender'' (check): Udofin generates, renders and issues none. Append-only (a correction is a new document that supersedes the old). The storage key is not selectable by any role: it is returned only by the open functions, which write the access log. A mock source exists only where the session allows mock providers. The production document store does not exist yet. Written only by servicing.register_loan_document. Owner: servicing module.';

create table servicing.loan_document_access (
  id uuid primary key default private.uuid_v7(),
  document_id uuid not null,
  lender_org_id uuid not null,
  actor_type text not null check (actor_type in ('borrower', 'lender')),
  actor_user_id uuid not null,
  purpose text not null check (purpose in ('view', 'download')),
  accessed_at timestamptz not null default clock_timestamp(),
  foreign key (document_id, lender_org_id) references servicing.loan_documents (id, lender_org_id) on delete restrict
);
create index loan_document_access_document on servicing.loan_document_access (document_id, accessed_at);
create index loan_document_access_lender on servicing.loan_document_access (lender_org_id, accessed_at desc);
comment on table servicing.loan_document_access is
  'Who opened which lender-issued document and when (no content), written by the open functions before the API streams the bytes: it records that access was granted, not that it was read. Append-only. Owner: servicing module.';

create table servicing.foreclosure_quotes (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null,
  lender_quote_ref text not null check (lender_quote_ref ~ '^[A-Za-z0-9._/-]{1,100}$'),
  as_of timestamptz not null,
  valid_until timestamptz not null,
  -- AS REPORTED by the lender. Udofin never computes, adjusts or rounds any of them.
  principal_minor bigint not null check (principal_minor between 0 and 100000000000000),
  interest_minor bigint not null check (interest_minor between 0 and 100000000000000),
  charges_minor bigint not null check (charges_minor between 0 and 100000000000000),
  prepayment_charge_minor bigint not null check (prepayment_charge_minor between 0 and 100000000000000),
  total_minor bigint not null check (total_minor between 0 and 100000000000000),
  -- A flag, never a correction: true when the lender's parts do not add up to the lender's total.
  total_mismatch boolean generated always as (principal_minor + interest_minor + charges_minor + prepayment_charge_minor <> total_minor) stored,
  source text not null check (source in ('lender_portal', 'lms', 'mock')),
  letter_document_id uuid,
  reported_by uuid references auth.users (id),
  reported_at timestamptz not null default clock_timestamp(),
  unique (id, lender_org_id),
  unique (id, loan_account_id),
  unique (loan_account_id, lender_quote_ref),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  foreign key (letter_document_id, loan_account_id) references servicing.loan_documents (id, loan_account_id) on delete restrict,
  constraint validity_order check (valid_until > as_of),
  constraint portal_is_attributed check (source <> 'lender_portal' or reported_by is not null)
);
create index foreclosure_quotes_loan on servicing.foreclosure_quotes (loan_account_id, as_of desc);
create index foreclosure_quotes_lender on servicing.foreclosure_quotes (lender_org_id, reported_at desc);
create index foreclosure_quotes_letter on servicing.foreclosure_quotes (letter_document_id, loan_account_id);
comment on table servicing.foreclosure_quotes is
  'Foreclosure quotations exactly as the LENDER reported them (reference, as-of, validity, components including any pre-payment charge, total). Udofin never computes or adjusts a quote. total_mismatch (generated) flags a lender quote whose parts do not add up to its total; it is never corrected and a consumer must treat a flagged quote as not payable until the lender re-quotes. Append-only. A foreclosure payment must equal an unexpired quote (servicing.latest_valid_quote). Written only by servicing.record_foreclosure_quote. Owner: servicing module.';
comment on column servicing.foreclosure_quotes.total_mismatch is
  'Generated flag: principal + interest + charges + pre-payment charge differs from the total the lender reported. A comparison of lender-reported numbers, not a Udofin figure.';

create table servicing.document_requests (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null,
  kind text not null check (kind in ('statement', 'foreclosure_quote', 'noc', 'closure_letter')),
  period_from date,
  period_to date,
  status text not null default 'requested' check (status in ('requested', 'fulfilled', 'declined', 'expired', 'cancelled')),
  -- From an APPROVED applicability rule; both empty when no approved rule resolves (rule unresolved).
  due_by timestamptz,
  due_rule_id uuid references documents.applicability_rules (id) on delete restrict,
  lender_note text check (lender_note is null or (length(lender_note) between 3 and 500 and private.servicing_text_safe(lender_note))),
  requested_by uuid not null references auth.users (id),
  requested_at timestamptz not null default clock_timestamp(),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  fulfilled_document_id uuid,
  fulfilled_quote_id uuid,
  unique (requested_by, idempotency_key),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  foreign key (fulfilled_document_id, loan_account_id) references servicing.loan_documents (id, loan_account_id) on delete restrict,
  foreign key (fulfilled_quote_id, loan_account_id) references servicing.foreclosure_quotes (id, loan_account_id) on delete restrict,
  constraint period_only_for_statements check ((period_from is null) = (period_to is null) and (period_from is null or kind = 'statement')),
  constraint period_order check (period_to is null or period_to >= period_from),
  constraint due_is_from_a_rule check ((due_by is null) = (due_rule_id is null)),
  constraint outcome_is_dated check ((status = 'requested') = (decided_at is null)),
  constraint decline_has_note_and_person check (status <> 'declined' or (lender_note is not null and decided_by is not null)),
  constraint fulfilled_has_one_result check (
    (status = 'fulfilled') = (fulfilled_document_id is not null or fulfilled_quote_id is not null)
    and not (fulfilled_document_id is not null and fulfilled_quote_id is not null)
    and (fulfilled_quote_id is null or kind = 'foreclosure_quote')
    and (fulfilled_document_id is null or kind <> 'foreclosure_quote')
  )
);
-- One open request per loan and kind.
create unique index document_requests_one_open on servicing.document_requests (loan_account_id, kind) where status = 'requested';
create index document_requests_loan on servicing.document_requests (loan_account_id, requested_at desc);
create index document_requests_queue on servicing.document_requests (lender_org_id, status, requested_at);
create index document_requests_due_rule on servicing.document_requests (due_rule_id);
create index document_requests_document on servicing.document_requests (fulfilled_document_id, loan_account_id);
create index document_requests_quote on servicing.document_requests (fulfilled_quote_id, loan_account_id);
comment on table servicing.document_requests is
  'A borrower''s request for a statement of account, foreclosure quote, no-dues/NOC or closure letter on their own loan. Idempotent on (user, key); one open request per loan and kind. requested -> fulfilled | declined | expired | cancelled, nothing else; the content never changes. due_by comes from an approved applicability rule (a PLATFORM default for statements and NOCs, not a regulatory deadline) and is empty when no approved rule resolves. The lender fulfils with servicing.register_loan_document / record_foreclosure_quote and declines with servicing.decline_document_request (permission servicing.document.issue). Owner: servicing module.';

create table servicing.closure_records (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null unique,
  closure_kind text not null check (closure_kind in ('closed', 'foreclosed')),
  -- When Udofin RECORDED the lender's report of closure (not the lender's closure date). Opened once per loan by a trigger.
  closed_at timestamptz not null default clock_timestamp(),
  noc_due_by timestamptz,
  noc_due_rule_id uuid references documents.applicability_rules (id) on delete restrict,
  noc_document_id uuid,
  noc_issued_at timestamptz,
  unique (id, lender_org_id),
  unique (id, loan_account_id),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  foreign key (noc_document_id, loan_account_id) references servicing.loan_documents (id, loan_account_id) on delete restrict,
  constraint noc_due_is_from_a_rule check ((noc_due_by is null) = (noc_due_rule_id is null)),
  constraint noc_issue_is_dated check ((noc_document_id is null) = (noc_issued_at is null))
);
create index closure_records_lender on servicing.closure_records (lender_org_id, closed_at desc);
create index closure_records_due_rule on servicing.closure_records (noc_due_rule_id);
create index closure_records_noc_document on servicing.closure_records (noc_document_id, loan_account_id);
comment on table servicing.closure_records is
  'One row per loan that the lender reported closed or foreclosed, opened by a trigger on servicing.loan_accounts (once per loan, idempotent) together with one outbox event ''servicing.loan_closed'' carrying ids only (reminders stop and mandates are cancelled by later consumers). noc_due_by is the platform SLA default from an approved rule, empty when unresolved. Only noc_document_id / noc_issued_at may be filled in later (once), by servicing.register_loan_document when the lender registers a NOC or closure letter. The record is not reverted if the lender later reports the loan active again; borrower reads show the live loan status next to it. Written only by the trigger and that function. Owner: servicing module.';

create table servicing.security_release_tasks (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null,
  closure_id uuid not null,
  collateral_type text not null check (collateral_type in ('mutual_fund_lien', 'demat_pledge', 'property_documents', 'vehicle_hypothecation', 'other')),
  status text not null default 'open' check (status in ('open', 'confirmed_by_lender')),
  due_by timestamptz,
  due_rule_id uuid references documents.applicability_rules (id) on delete restrict,
  -- Lender-supplied text shown to the borrower.
  delay_reason text check (delay_reason is null or (length(delay_reason) between 10 and 500 and private.servicing_text_safe(delay_reason))),
  delay_reason_by uuid references auth.users (id),
  delay_reason_at timestamptz,
  lender_confirmation_ref text check (lender_confirmation_ref is null or lender_confirmation_ref ~ '^[A-Za-z0-9._/-]{3,100}$'),
  confirmed_by uuid references auth.users (id),
  confirmed_at timestamptz,
  opened_by uuid references auth.users (id),
  created_at timestamptz not null default clock_timestamp(),
  unique (loan_account_id, collateral_type),
  unique (id, lender_org_id),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  foreign key (closure_id, loan_account_id) references servicing.closure_records (id, loan_account_id) on delete restrict,
  constraint due_is_from_a_rule check ((due_by is null) = (due_rule_id is null)),
  constraint delay_reason_is_attributed check ((delay_reason is null) = (delay_reason_by is null and delay_reason_at is null)),
  constraint confirmation_needs_evidence check ((status = 'confirmed_by_lender') = (lender_confirmation_ref is not null and confirmed_by is not null and confirmed_at is not null)),
  constraint confirmation_is_complete check ((lender_confirmation_ref is null) = (confirmed_by is null and confirmed_at is null))
);
create index security_release_tasks_closure on servicing.security_release_tasks (closure_id, loan_account_id);
create index security_release_tasks_lender on servicing.security_release_tasks (lender_org_id, status, due_by);
create index security_release_tasks_due_rule on servicing.security_release_tasks (due_rule_id);
comment on table servicing.security_release_tasks is
  'Release of security on closure (lender-reported collateral types; NO LAMF or other secured product is enabled, tests use a fixture). Udofin holds no collateral and has no depository or RTA access: the lender, as lien holder or pledgee, releases it. A task is open until a lender user holding servicing.document.issue confirms it with the lender''s own confirmation reference (status confirmed_by_lender); the database refuses any other confirmer, including the system role and platform staff. Displaying or submitting a prompt never means anything was released. due_by is from an approved rule (RBC paras 35 to 36), empty when unresolved. Written only by servicing.open_security_release_tasks, confirm_security_release and set_security_release_delay_reason. Owner: servicing module.';

-- ---------------------------------------------------------------------------------------------
-- D. Triggers: append-only, guards, no truncate
-- ---------------------------------------------------------------------------------------------
create trigger append_only before update or delete on servicing.loan_documents
  for each row execute function private.forbid_mutation();
create trigger append_only before update or delete on servicing.loan_document_access
  for each row execute function private.forbid_mutation();
create trigger append_only before update or delete on servicing.foreclosure_quotes
  for each row execute function private.forbid_mutation();
create trigger no_delete before delete on servicing.document_requests
  for each row execute function private.forbid_mutation();
create trigger no_delete before delete on servicing.closure_records
  for each row execute function private.forbid_mutation();
create trigger no_delete before delete on servicing.security_release_tasks
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.loan_documents for each statement execute function private.forbid_truncate();
create trigger no_truncate before truncate on servicing.loan_document_access for each statement execute function private.forbid_truncate();
create trigger no_truncate before truncate on servicing.foreclosure_quotes for each statement execute function private.forbid_truncate();
create trigger no_truncate before truncate on servicing.document_requests for each statement execute function private.forbid_truncate();
create trigger no_truncate before truncate on servicing.closure_records for each statement execute function private.forbid_truncate();
create trigger no_truncate before truncate on servicing.security_release_tasks for each statement execute function private.forbid_truncate();

-- A mock source exists only where the session allows mock providers (the foundation pattern, three levels with
-- assertProviderAllowed and configuration). Applies to every writer, including the table owner.
create or replace function private.servicing_guard_loan_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s servicing.loan_documents;
begin
  if new.source = 'mock' and not private.mock_providers_allowed() then
    raise exception 'a mock document is refused outside local and test sessions' using errcode = '42501', hint = 'mock_provider_blocked';
  end if;
  if new.issued_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'a document cannot be issued in the future' using errcode = '22023', hint = 'issued_at_invalid';
  end if;
  if new.supersedes_id is not null then
    select * into s from servicing.loan_documents d where d.id = new.supersedes_id;
    if not found or s.loan_account_id <> new.loan_account_id or s.kind <> new.kind then
      raise exception 'a document can only supersede an earlier document of the same kind on the same loan' using errcode = '22023', hint = 'supersedes_invalid';
    end if;
  end if;
  return new;
end
$$;
revoke all on function private.servicing_guard_loan_document() from public;
create trigger guard before insert on servicing.loan_documents
  for each row execute function private.servicing_guard_loan_document();

create or replace function private.servicing_guard_quote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d servicing.loan_documents;
begin
  if new.source = 'mock' and not private.mock_providers_allowed() then
    raise exception 'a mock quotation is refused outside local and test sessions' using errcode = '42501', hint = 'mock_provider_blocked';
  end if;
  if new.as_of > clock_timestamp() + interval '5 minutes' then
    raise exception 'a quotation cannot be as of a future time' using errcode = '22023', hint = 'as_of_invalid';
  end if;
  if new.letter_document_id is not null then
    select * into d from servicing.loan_documents x where x.id = new.letter_document_id;
    if not found or d.kind <> 'foreclosure_quote' then
      raise exception 'the letter of a quotation must be a foreclosure_quote document' using errcode = '22023', hint = 'letter_invalid';
    end if;
  end if;
  return new;
end
$$;
revoke all on function private.servicing_guard_quote() from public;
create trigger guard before insert on servicing.foreclosure_quotes
  for each row execute function private.servicing_guard_quote();

-- A request keeps its content; it only records its outcome, once.
create or replace function private.servicing_protect_document_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
begin
  if (to_jsonb(new) - array['status', 'lender_note', 'decided_by', 'decided_at', 'fulfilled_document_id', 'fulfilled_quote_id'])
     is distinct from
     (to_jsonb(old) - array['status', 'lender_note', 'decided_by', 'decided_at', 'fulfilled_document_id', 'fulfilled_quote_id']) then
    raise exception 'a document request cannot be edited; only its outcome is recorded' using errcode = 'P0001', hint = 'request_immutable';
  end if;
  if old.status <> 'requested' then
    raise exception 'a closed document request is final' using errcode = 'P0001', hint = 'request_final';
  end if;
  if new.status = 'requested' then
    raise exception 'a document request can only move to an outcome' using errcode = 'P0001', hint = 'request_immutable';
  end if;
  if new.fulfilled_document_id is not null then
    select d.kind into v_kind from servicing.loan_documents d where d.id = new.fulfilled_document_id;
    if v_kind is distinct from new.kind then
      raise exception 'the document does not match the kind requested' using errcode = '55000', hint = 'request_kind_mismatch';
    end if;
  end if;
  return new;
end
$$;
revoke all on function private.servicing_protect_document_request() from public;
create trigger protect before update on servicing.document_requests
  for each row execute function private.servicing_protect_document_request();

-- The closure record is a fact; only the NOC reference may be added, once.
create or replace function private.servicing_protect_closure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['noc_document_id', 'noc_issued_at']) is distinct from (to_jsonb(old) - array['noc_document_id', 'noc_issued_at']) then
    raise exception 'a closure record cannot be edited' using errcode = 'P0001', hint = 'closure_immutable';
  end if;
  if old.noc_document_id is not null then
    raise exception 'the NOC reference of a closure record is set once' using errcode = 'P0001', hint = 'closure_immutable';
  end if;
  return new;
end
$$;
revoke all on function private.servicing_protect_closure() from public;
create trigger protect before update on servicing.closure_records
  for each row execute function private.servicing_protect_closure();

-- Security-release tasks: content is fixed; the status moves open -> confirmed_by_lender once, and ONLY a lender user holding
-- servicing.document.issue in that lender can be the confirmer. Udofin (system role, platform staff) can never confirm, whoever
-- writes the row, including the table owner.
create or replace function private.servicing_protect_release_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'open' then
      raise exception 'a task is opened unconfirmed; only the lender can confirm it' using errcode = '55000', hint = 'lender_confirmation_only';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'delay_reason', 'delay_reason_by', 'delay_reason_at', 'lender_confirmation_ref', 'confirmed_by', 'confirmed_at'])
     is distinct from
     (to_jsonb(old) - array['status', 'delay_reason', 'delay_reason_by', 'delay_reason_at', 'lender_confirmation_ref', 'confirmed_by', 'confirmed_at']) then
    raise exception 'a security-release task cannot be edited' using errcode = 'P0001', hint = 'task_immutable';
  end if;
  if old.status = 'confirmed_by_lender' then
    raise exception 'a confirmed task is final' using errcode = 'P0001', hint = 'task_final';
  end if;
  if new.status = 'confirmed_by_lender' then
    if new.confirmed_by is null
       or not private.user_has_permission_in_org(new.confirmed_by, new.lender_org_id, 'servicing.document.issue') then
      raise exception 'only a lender user with the issue permission can confirm a release' using errcode = '42501', hint = 'lender_confirmation_only';
    end if;
  end if;
  return new;
end
$$;
revoke all on function private.servicing_protect_release_task() from public;
create trigger protect before insert or update on servicing.security_release_tasks
  for each row execute function private.servicing_protect_release_task();

-- ---------------------------------------------------------------------------------------------
-- E. Closure trigger: opens exactly one closure record per loan when the lender's report makes it closed or foreclosed.
--    It does not depend on the statements_noc switch: reminders must stop and mandates must be cancelled whether or not the
--    document workflow is on (the switch decides what borrowers and lenders can DO with the record, below).
-- ---------------------------------------------------------------------------------------------
create or replace function private.servicing_open_closure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_closure uuid;
  v_rule uuid;
  v_days integer;
  v_due timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if new.status not in ('closed', 'foreclosed') then return new; end if;
  if exists (select 1 from servicing.closure_records c where c.loan_account_id = new.id) then return new; end if;
  select r.rule_id, r.days into v_rule, v_days
    from private.servicing_rule_days(new.lender_org_id, 'servicing.noc_sla_days_default', private.servicing_loan_category(new.id), private.servicing_ist_today()) r;
  if v_days is not null then
    v_due := v_now + make_interval(days => v_days);
  else
    v_rule := null;
  end if;
  insert into servicing.closure_records (lender_org_id, loan_account_id, closure_kind, closed_at, noc_due_by, noc_due_rule_id)
  values (new.lender_org_id, new.id, new.status::text, v_now, v_due, v_rule)
  on conflict (loan_account_id) do nothing
  returning id into v_closure;
  if v_closure is not null then
    perform ops.enqueue_event('servicing.loan_closed',
      jsonb_build_object('closure_id', v_closure, 'loan_account_id', new.id, 'lender_org_id', new.lender_org_id),
      null, 'servicing.loan_closed:' || new.id::text);
    perform private.servicing_docs_audit(new.lender_org_id, 'servicing.closure.opened', 'closure_record', v_closure::text,
      jsonb_build_object('loan_account_id', new.id, 'closure_kind', new.status::text, 'due_rule_resolved', v_rule is not null));
  end if;
  return new;
end
$$;
revoke all on function private.servicing_open_closure() from public;
create trigger loan_accounts_open_closure_on_insert after insert on servicing.loan_accounts
  for each row when (new.status in ('closed', 'foreclosed')) execute function private.servicing_open_closure();
create trigger loan_accounts_open_closure_on_update after update of status on servicing.loan_accounts
  for each row when (new.status in ('closed', 'foreclosed') and old.status is distinct from new.status) execute function private.servicing_open_closure();

-- ---------------------------------------------------------------------------------------------
-- F. Row level security and grants. Borrowers have NO table access (functions only). Lenders read their own rows (loan.read).
--    Nobody writes these tables directly: the definer functions below do.
-- ---------------------------------------------------------------------------------------------
alter table servicing.loan_documents enable row level security;
alter table servicing.loan_documents force row level security;
alter table servicing.loan_document_access enable row level security;
alter table servicing.loan_document_access force row level security;
alter table servicing.foreclosure_quotes enable row level security;
alter table servicing.foreclosure_quotes force row level security;
alter table servicing.document_requests enable row level security;
alter table servicing.document_requests force row level security;
alter table servicing.closure_records enable row level security;
alter table servicing.closure_records force row level security;
alter table servicing.security_release_tasks enable row level security;
alter table servicing.security_release_tasks force row level security;

create policy loan_documents_lender_read on servicing.loan_documents for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('loan.read')));
create policy loan_document_access_lender_read on servicing.loan_document_access for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('loan.read')));
create policy foreclosure_quotes_lender_read on servicing.foreclosure_quotes for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('loan.read')));
create policy document_requests_lender_read on servicing.document_requests for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('loan.read')));
create policy closure_records_lender_read on servicing.closure_records for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('loan.read')));
create policy security_release_tasks_lender_read on servicing.security_release_tasks for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('loan.read')));

-- The default privilege gives service_role ALL on new domain tables. It gets read only here (never the storage key): system code
-- must never be able to forge a document, a quote, a request outcome or a release confirmation.
revoke all on servicing.loan_documents, servicing.loan_document_access, servicing.foreclosure_quotes, servicing.document_requests,
  servicing.closure_records, servicing.security_release_tasks from service_role;
grant select on servicing.loan_document_access, servicing.foreclosure_quotes, servicing.document_requests,
  servicing.closure_records, servicing.security_release_tasks to service_role, authenticated;
grant select (id, lender_org_id, loan_account_id, kind, issuer, lender_reference, issued_at, received_at, period_from, period_to,
              sha256, size_bytes, mime_type, supersedes_id, source, uploaded_by)
  on servicing.loan_documents to service_role, authenticated;

-- ---------------------------------------------------------------------------------------------
-- G. Borrower functions (SECURITY DEFINER; the signed-in borrower and nobody else)
-- ---------------------------------------------------------------------------------------------
create or replace function servicing.request_document(
  p_loan uuid, p_kind text, p_idempotency_key text, p_period_from date default null, p_period_to date default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  l servicing.loan_accounts;
  r servicing.document_requests;
  v_rule uuid;
  v_days integer;
  v_due timestamptz;
  v_id uuid;
  v_today date := private.servicing_ist_today();
  v_now timestamptz := clock_timestamp();
  v_rule_key text;
begin
  l := private.servicing_docs_borrower_loan(p_loan);
  perform private.require_feature(l.lender_org_id, 'statements_noc');
  if p_kind is null or p_kind not in ('statement', 'foreclosure_quote', 'noc', 'closure_letter') then
    raise exception 'unknown document kind' using errcode = '22023', hint = 'kind_invalid';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' then
    raise exception 'an idempotency key of 8 to 100 safe characters is required' using errcode = '22023', hint = 'idempotency_key_invalid';
  end if;
  select * into r from servicing.document_requests x where x.requested_by = v_uid and x.idempotency_key = p_idempotency_key;
  if found then
    if (r.loan_account_id, r.kind, r.period_from, r.period_to) is not distinct from (p_loan, p_kind, p_period_from, p_period_to) then
      return r.id;
    end if;
    raise exception 'this idempotency key was used for a different request' using errcode = '23505', hint = 'idempotency_conflict';
  end if;

  if p_kind = 'statement' then
    if l.status = 'cancelled' then
      raise exception 'no statement exists for a cancelled loan' using errcode = '55000', hint = 'loan_status_not_eligible';
    end if;
    if (p_period_from is null) <> (p_period_to is null)
       or (p_period_from is not null and (p_period_to < p_period_from or p_period_to > v_today or p_period_from < date '2000-01-01')) then
      raise exception 'the statement period is invalid' using errcode = '22023', hint = 'period_invalid';
    end if;
  else
    if p_period_from is not null or p_period_to is not null then
      raise exception 'a period applies to statements only' using errcode = '22023', hint = 'period_not_allowed';
    end if;
    if p_kind = 'foreclosure_quote' and l.status <> 'active' then
      raise exception 'a foreclosure quotation is for an active loan' using errcode = '55000', hint = 'loan_not_active';
    end if;
    if p_kind in ('noc', 'closure_letter') and l.status not in ('closed', 'foreclosed') then
      raise exception 'a no-dues letter is for a loan the lender has reported closed' using errcode = '55000', hint = 'loan_not_closed';
    end if;
  end if;
  if exists (select 1 from servicing.document_requests x where x.loan_account_id = p_loan and x.kind = p_kind and x.status = 'requested') then
    raise exception 'a request of this kind is already open for the loan' using errcode = '23505', hint = 'open_request_exists';
  end if;

  v_rule_key := case p_kind when 'statement' then 'servicing.statement_sla_days_default' when 'foreclosure_quote' then null else 'servicing.noc_sla_days_default' end;
  if v_rule_key is not null then
    select x.rule_id, x.days into v_rule, v_days
      from private.servicing_rule_days(l.lender_org_id, v_rule_key, private.servicing_loan_category(p_loan), v_today) x;
    if v_days is not null then v_due := v_now + make_interval(days => v_days); else v_rule := null; end if;
  end if;

  begin
    insert into servicing.document_requests (lender_org_id, loan_account_id, kind, period_from, period_to, due_by, due_rule_id, requested_by, requested_at, idempotency_key)
    values (l.lender_org_id, p_loan, p_kind, p_period_from, p_period_to, v_due, v_rule, v_uid, v_now, p_idempotency_key)
    returning id into v_id;
  exception when unique_violation then
    select * into r from servicing.document_requests x where x.requested_by = v_uid and x.idempotency_key = p_idempotency_key;
    if found and (r.loan_account_id, r.kind, r.period_from, r.period_to) is not distinct from (p_loan, p_kind, p_period_from, p_period_to) then
      return r.id;
    end if;
    raise exception 'a request of this kind is already open for the loan' using errcode = '23505', hint = 'open_request_exists';
  end;
  perform private.servicing_docs_audit(l.lender_org_id, 'servicing.document_request.created', 'document_request', v_id::text,
    jsonb_build_object('loan_account_id', p_loan, 'kind', p_kind, 'due_rule_resolved', v_rule is not null));
  return v_id;
end
$$;

create or replace function servicing.cancel_document_request(p_request uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  r servicing.document_requests;
begin
  select x.* into r from servicing.document_requests x
    join servicing.loan_accounts la on la.id = x.loan_account_id
   where x.id = p_request and la.borrower_id = private.my_borrower_id() and private.my_borrower_id() is not null;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  perform private.require_feature(r.lender_org_id, 'statements_noc');
  if r.status <> 'requested' then
    raise exception 'only an open request can be cancelled' using errcode = '55000', hint = 'request_not_open';
  end if;
  update servicing.document_requests set status = 'cancelled', decided_by = v_uid, decided_at = clock_timestamp() where id = p_request;
  perform private.servicing_docs_audit(r.lender_org_id, 'servicing.document_request.cancelled', 'document_request', p_request::text,
    jsonb_build_object('loan_account_id', r.loan_account_id, 'kind', r.kind));
  return 'cancelled';
end
$$;

create or replace function servicing.my_document_requests(p_loan uuid)
returns table (
  request_id uuid, kind text, status text, period_from date, period_to date, requested_at timestamptz, due_by timestamptz,
  due_rule_key text, due_evidence_status text, lender_note text, decided_at timestamptz, fulfilled_document_id uuid, fulfilled_quote_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
begin
  l := private.servicing_docs_borrower_loan(p_loan);
  if not private.feature_enabled(l.lender_org_id, 'statements_noc') then return; end if;
  return query
    select x.id, x.kind, x.status, x.period_from, x.period_to, x.requested_at, x.due_by, ru.rule_key, ru.evidence_status, x.lender_note, x.decided_at,
           x.fulfilled_document_id, x.fulfilled_quote_id
    from servicing.document_requests x
    left join documents.applicability_rules ru on ru.id = x.due_rule_id
    where x.loan_account_id = p_loan
    order by x.requested_at desc, x.id;
end
$$;

create or replace function servicing.my_loan_documents(p_loan uuid)
returns table (
  document_id uuid, kind text, issuer text, lender_reference text, issued_at timestamptz, period_from date, period_to date, size_bytes bigint,
  sha256 text, source text, superseded_by_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
begin
  l := private.servicing_docs_borrower_loan(p_loan);
  if not private.feature_enabled(l.lender_org_id, 'statements_noc') then return; end if;
  return query
    select d.id, d.kind, d.issuer, d.lender_reference, d.issued_at, d.period_from, d.period_to, d.size_bytes, d.sha256, d.source,
           (select s.id from servicing.loan_documents s where s.supersedes_id = d.id)
    from servicing.loan_documents d
    where d.loan_account_id = p_loan and (d.source <> 'mock' or private.mock_providers_allowed())
    order by d.issued_at desc, d.id;
end
$$;

-- The API calls this before streaming the bytes and verifies the SHA-256 it returns. Writes the access row.
create or replace function servicing.open_loan_document(p_doc uuid, p_purpose text default 'download')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d servicing.loan_documents;
  v_borrower uuid := private.my_borrower_id();
begin
  select x.* into d from servicing.loan_documents x
    join servicing.loan_accounts la on la.id = x.loan_account_id
   where x.id = p_doc and v_borrower is not null and la.borrower_id = v_borrower;
  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  perform private.require_feature(d.lender_org_id, 'statements_noc');
  if p_purpose is null or p_purpose not in ('view', 'download') then
    raise exception 'invalid purpose' using errcode = '22023', hint = 'purpose_invalid';
  end if;
  if d.source = 'mock' and not private.mock_providers_allowed() then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  insert into servicing.loan_document_access (document_id, lender_org_id, actor_type, actor_user_id, purpose)
  values (d.id, d.lender_org_id, 'borrower', (select auth.uid()), p_purpose);
  return jsonb_build_object('document_id', d.id, 'loan_account_id', d.loan_account_id, 'kind', d.kind, 'storage_key', d.storage_key, 'sha256', d.sha256,
                            'size_bytes', d.size_bytes, 'mime_type', d.mime_type, 'lender_reference', d.lender_reference, 'source', d.source);
end
$$;

-- The closure screen: facts as the lender reported them, due dates with their basis, and a prompt KEY per security-release
-- task. A prompt key never says anything was released unless the lender confirmed it.
create or replace function servicing.my_closure(p_loan uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
  c servicing.closure_records;
  v_lender text;
  v_tasks jsonb;
  v_basis jsonb;
begin
  l := private.servicing_docs_borrower_loan(p_loan);
  perform private.require_feature(l.lender_org_id, 'statements_noc');
  select * into c from servicing.closure_records x where x.loan_account_id = p_loan;
  if not found then return null; end if;
  select o.display_name into v_lender from tenancy.organizations o where o.id = l.lender_org_id;
  select jsonb_build_object('rule_key', r.rule_key, 'rule_version', r.version, 'evidence_status', r.evidence_status)
    into v_basis from documents.applicability_rules r where r.id = c.noc_due_rule_id;
  select coalesce(jsonb_agg(jsonb_build_object(
      'task_id', t.id, 'collateral_type', t.collateral_type, 'status', t.status, 'status_source', 'lender',
      'prompt_key', 'closure.security_release.' || t.collateral_type || case t.status when 'confirmed_by_lender' then '.lender_confirmed' else '.lender_to_release' end,
      'lender_confirmed', t.status = 'confirmed_by_lender', 'due_by', t.due_by,
      'due_basis', (select jsonb_build_object('rule_key', r.rule_key, 'rule_version', r.version, 'evidence_status', r.evidence_status)
                      from documents.applicability_rules r where r.id = t.due_rule_id),
      'delay_reason', t.delay_reason, 'confirmed_at', t.confirmed_at) order by t.collateral_type), '[]'::jsonb)
    into v_tasks from servicing.security_release_tasks t where t.loan_account_id = p_loan;
  return jsonb_build_object(
    'loan_account_id', l.id, 'lender_display_name', v_lender, 'loan_status', l.status, 'closure_kind', c.closure_kind,
    'closure_recorded_at', c.closed_at,
    'noc_status', case when c.noc_document_id is null then 'pending' else 'issued' end, 'noc_status_source', 'lender',
    'noc_prompt_key', case when c.noc_document_id is null then 'closure.noc.lender_to_issue' else 'closure.noc.issued_by_lender' end,
    'noc_due_by', c.noc_due_by, 'noc_due_basis', v_basis, 'noc_document_id', c.noc_document_id, 'noc_issued_at', c.noc_issued_at,
    'security_release_tasks', v_tasks);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- H. Lender functions (permission servicing.document.issue for writes; loan.read for reads)
-- ---------------------------------------------------------------------------------------------
create or replace function servicing.decline_document_request(p_request uuid, p_note text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r servicing.document_requests;
  v_uid uuid;
begin
  select * into r from servicing.document_requests x where x.id = p_request;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  v_uid := private.servicing_docs_actor(r.lender_org_id, 'servicing.document.issue', false);
  perform private.require_feature(r.lender_org_id, 'statements_noc');
  if p_note is null or length(trim(p_note)) < 10 or length(trim(p_note)) > 500 or not private.servicing_text_safe(trim(p_note)) then
    raise exception 'a reason of 10 to 500 characters, without personal data, is required' using errcode = '22023', hint = 'note_invalid';
  end if;
  if r.status <> 'requested' then
    raise exception 'only an open request can be declined' using errcode = '55000', hint = 'request_not_open';
  end if;
  update servicing.document_requests set status = 'declined', lender_note = trim(p_note), decided_by = v_uid, decided_at = clock_timestamp() where id = p_request;
  perform private.servicing_docs_audit(r.lender_org_id, 'servicing.document_request.declined', 'document_request', p_request::text,
    jsonb_build_object('loan_account_id', r.loan_account_id, 'kind', r.kind));
  return 'declined';
end
$$;

-- Registers a document the LENDER issued (the API has already checked upload safety and stored the bytes; this function only
-- records the key and hash). A person registers as 'lender_upload'; the system role may register an 'lms' (or 'mock') document.
create or replace function servicing.register_loan_document(
  p_loan uuid, p_kind text, p_storage_key text, p_sha256 text, p_size_bytes bigint, p_mime_type text, p_lender_reference text,
  p_issued_at timestamptz, p_period_from date default null, p_period_to date default null, p_supersedes uuid default null,
  p_request uuid default null, p_source text default 'lender_upload')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
  v_uid uuid;
  d servicing.loan_documents;
  s servicing.loan_documents;
  rq servicing.document_requests;
  v_id uuid;
begin
  select * into l from servicing.loan_accounts la where la.id = p_loan;
  if not found then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  v_uid := private.servicing_docs_actor(l.lender_org_id, 'servicing.document.issue', true);
  perform private.require_feature(l.lender_org_id, 'statements_noc');

  if v_uid is not null then
    if p_source is distinct from 'lender_upload' then
      raise exception 'a signed-in lender user registers an upload' using errcode = '22023', hint = 'source_invalid';
    end if;
  elsif p_source is null or p_source not in ('lms', 'mock') then
    raise exception 'the system registers lms (or mock) documents only' using errcode = '22023', hint = 'source_invalid';
  end if;
  if p_kind is null or p_kind not in ('statement', 'foreclosure_quote', 'noc', 'closure_letter') then
    raise exception 'unknown document kind' using errcode = '22023', hint = 'kind_invalid';
  end if;
  if p_mime_type is distinct from 'application/pdf' then
    raise exception 'only application/pdf is accepted' using errcode = '22023', hint = 'mime_not_allowed';
  end if;
  if p_storage_key is null or p_storage_key !~ '^servicing/[A-Za-z0-9/_-]{8,180}$' then
    raise exception 'invalid storage key' using errcode = '22023', hint = 'storage_key_invalid';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid sha256' using errcode = '22023', hint = 'sha256_invalid';
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 26214400 then
    raise exception 'invalid size' using errcode = '22023', hint = 'size_invalid';
  end if;
  if p_lender_reference is null or p_lender_reference !~ '^[A-Za-z0-9._/-]{1,100}$' then
    raise exception 'invalid lender reference' using errcode = '22023', hint = 'reference_invalid';
  end if;
  if p_issued_at is null or p_issued_at < timestamptz '2000-01-01 00:00:00+00' or p_issued_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid issue time' using errcode = '22023', hint = 'issued_at_invalid';
  end if;
  if p_kind = 'statement' then
    if p_period_from is null or p_period_to is null or p_period_to < p_period_from or p_period_from < date '2000-01-01'
       or p_period_to > private.servicing_ist_today() then
      raise exception 'a statement needs a valid period' using errcode = '22023', hint = 'period_invalid';
    end if;
  elsif p_period_from is not null or p_period_to is not null then
    raise exception 'a period applies to statements only' using errcode = '22023', hint = 'period_not_allowed';
  end if;

  -- Idempotent on the lender's own reference: same bytes return the same row, different bytes are a conflict.
  select * into d from servicing.loan_documents x where x.loan_account_id = p_loan and x.kind = p_kind and x.lender_reference = p_lender_reference;
  if found then
    if d.sha256 = p_sha256 then return d.id; end if;
    raise exception 'this lender reference was already used for a different file' using errcode = '23505', hint = 'lender_reference_reused';
  end if;
  if exists (select 1 from servicing.loan_documents x where x.storage_key = p_storage_key) then
    raise exception 'this storage key is already in use' using errcode = '23505', hint = 'storage_key_in_use';
  end if;
  if p_supersedes is not null then
    select * into s from servicing.loan_documents x where x.id = p_supersedes and x.loan_account_id = p_loan;
    if not found or s.kind <> p_kind then
      raise exception 'a document can only supersede an earlier document of the same kind on the same loan' using errcode = '22023', hint = 'supersedes_invalid';
    end if;
    if exists (select 1 from servicing.loan_documents x where x.supersedes_id = p_supersedes) then
      raise exception 'that document was already superseded' using errcode = '23505', hint = 'already_superseded';
    end if;
  end if;
  if p_request is not null then
    select * into rq from servicing.document_requests x where x.id = p_request and x.loan_account_id = p_loan for update;
    if not found or rq.status <> 'requested' then
      raise exception 'the request is not open' using errcode = '55000', hint = 'request_not_open';
    end if;
    if rq.kind <> p_kind or p_kind = 'foreclosure_quote' then
      raise exception 'the document does not match the kind requested' using errcode = '55000', hint = 'request_kind_mismatch';
    end if;
    if rq.period_from is not null and (p_period_from > rq.period_from or p_period_to < rq.period_to) then
      raise exception 'the statement does not cover the period requested' using errcode = '55000', hint = 'period_does_not_cover_request';
    end if;
  end if;

  insert into servicing.loan_documents (lender_org_id, loan_account_id, kind, lender_reference, issued_at, period_from, period_to, storage_key, sha256,
                                        size_bytes, mime_type, supersedes_id, source, uploaded_by)
  values (l.lender_org_id, p_loan, p_kind, p_lender_reference, p_issued_at, p_period_from, p_period_to, p_storage_key, p_sha256,
          p_size_bytes, p_mime_type, p_supersedes, p_source, v_uid)
  returning id into v_id;
  if p_request is not null then
    update servicing.document_requests set status = 'fulfilled', fulfilled_document_id = v_id, decided_by = v_uid, decided_at = clock_timestamp()
     where id = p_request;
  end if;
  if p_kind in ('noc', 'closure_letter') then
    update servicing.closure_records set noc_document_id = v_id, noc_issued_at = p_issued_at
     where loan_account_id = p_loan and noc_document_id is null;
  end if;
  perform private.servicing_docs_audit(l.lender_org_id, 'servicing.loan_document.registered', 'loan_document', v_id::text,
    jsonb_build_object('loan_account_id', p_loan, 'kind', p_kind, 'source', p_source, 'request_id', p_request, 'supersedes_id', p_supersedes));
  return v_id;
end
$$;

-- Records a quotation exactly as the lender reported it (money as decimal rupee text, parsed by the one strict parser). A
-- mismatch between the parts and the total is flagged by the table, never corrected. A request of kind foreclosure_quote is
-- fulfilled by passing it here.
create or replace function servicing.record_foreclosure_quote(
  p_loan uuid, p_lender_quote_ref text, p_as_of timestamptz, p_valid_until timestamptz,
  p_principal text, p_interest text, p_charges text, p_prepayment_charge text, p_total text,
  p_source text default 'lender_portal', p_request uuid default null, p_letter_document uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
  v_uid uuid;
  q servicing.foreclosure_quotes;
  rq servicing.document_requests;
  v_principal bigint;
  v_interest bigint;
  v_charges bigint;
  v_prepay bigint;
  v_total bigint;
  v_id uuid;
begin
  select * into l from servicing.loan_accounts la where la.id = p_loan;
  if not found then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  v_uid := private.servicing_docs_actor(l.lender_org_id, 'servicing.document.issue', true);
  perform private.require_feature(l.lender_org_id, 'statements_noc');
  if v_uid is not null then
    if p_source is distinct from 'lender_portal' then
      raise exception 'a signed-in lender user records a portal quotation' using errcode = '22023', hint = 'source_invalid';
    end if;
  elsif p_source is null or p_source not in ('lms', 'mock') then
    raise exception 'the system records lms (or mock) quotations only' using errcode = '22023', hint = 'source_invalid';
  end if;
  if p_lender_quote_ref is null or p_lender_quote_ref !~ '^[A-Za-z0-9._/-]{1,100}$' then
    raise exception 'invalid quotation reference' using errcode = '22023', hint = 'reference_invalid';
  end if;
  if p_as_of is null or p_valid_until is null or p_as_of < timestamptz '2000-01-01 00:00:00+00' or p_as_of > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid as-of time' using errcode = '22023', hint = 'as_of_invalid';
  end if;
  if p_valid_until <= p_as_of then
    raise exception 'the validity must end after the as-of time' using errcode = '22023', hint = 'validity_order';
  end if;
  -- The one strict parser: 22023 money_invalid for anything but plain rupees with at most two decimals.
  v_principal := private.parse_money_minor(p_principal);
  v_interest := private.parse_money_minor(p_interest);
  v_charges := private.parse_money_minor(p_charges);
  v_prepay := private.parse_money_minor(p_prepayment_charge);
  v_total := private.parse_money_minor(p_total);

  select * into q from servicing.foreclosure_quotes x where x.loan_account_id = p_loan and x.lender_quote_ref = p_lender_quote_ref;
  if found then
    if (q.as_of, q.valid_until, q.principal_minor, q.interest_minor, q.charges_minor, q.prepayment_charge_minor, q.total_minor)
       is not distinct from (p_as_of, p_valid_until, v_principal, v_interest, v_charges, v_prepay, v_total) then
      return q.id;
    end if;
    raise exception 'this quotation reference was already used for different figures' using errcode = '23505', hint = 'quote_ref_reused';
  end if;
  if p_letter_document is not null
     and not exists (select 1 from servicing.loan_documents d where d.id = p_letter_document and d.loan_account_id = p_loan and d.kind = 'foreclosure_quote') then
    raise exception 'the letter must be a foreclosure_quote document of this loan' using errcode = '22023', hint = 'letter_invalid';
  end if;
  if p_request is not null then
    select * into rq from servicing.document_requests x where x.id = p_request and x.loan_account_id = p_loan for update;
    if not found or rq.status <> 'requested' then
      raise exception 'the request is not open' using errcode = '55000', hint = 'request_not_open';
    end if;
    if rq.kind <> 'foreclosure_quote' then
      raise exception 'the request is not for a foreclosure quotation' using errcode = '55000', hint = 'request_kind_mismatch';
    end if;
    if p_valid_until <= clock_timestamp() then
      raise exception 'an expired quotation cannot fulfil a request' using errcode = '55000', hint = 'quote_already_expired';
    end if;
  end if;

  insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor,
                                            prepayment_charge_minor, total_minor, source, letter_document_id, reported_by)
  values (l.lender_org_id, p_loan, p_lender_quote_ref, p_as_of, p_valid_until, v_principal, v_interest, v_charges, v_prepay, v_total, p_source,
          p_letter_document, v_uid)
  returning id into v_id;
  if p_request is not null then
    update servicing.document_requests set status = 'fulfilled', fulfilled_quote_id = v_id, decided_by = v_uid, decided_at = clock_timestamp()
     where id = p_request;
  end if;
  perform private.servicing_docs_audit(l.lender_org_id, 'servicing.foreclosure_quote.recorded', 'foreclosure_quote', v_id::text,
    jsonb_build_object('loan_account_id', p_loan, 'source', p_source, 'request_id', p_request,
                       'total_mismatch', (v_principal + v_interest + v_charges + v_prepay) <> v_total));
  return v_id;
end
$$;

-- The newest unexpired quotation for a loan, as the lender reported it (zero rows when there is none, the feature is off, or the
-- caller may not see the loan: the three look the same). A consumer (a foreclosure payment) must also refuse a row whose
-- total_mismatch is true. Callable by the system, the owning borrower and the lender's staff (loan.read).
create or replace function servicing.latest_valid_quote(p_loan uuid)
returns setof servicing.foreclosure_quotes
language plpgsql
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
begin
  select * into l from servicing.loan_accounts la where la.id = p_loan;
  if not found then return; end if;
  if private.invoking_role() <> 'service_role' then
    -- Null-safe on both sides: a caller who is neither the borrower nor a reader of the lender's loans gets nothing.
    if not (coalesce(l.borrower_id = private.my_borrower_id(), false)
            or coalesce(l.lender_org_id in (select private.orgs_with_permission('loan.read')), false)) then
      return;
    end if;
  end if;
  if not private.feature_enabled(l.lender_org_id, 'statements_noc') then return; end if;
  return query
    select q.* from servicing.foreclosure_quotes q
    where q.loan_account_id = p_loan and q.valid_until > clock_timestamp()
      and (q.source <> 'mock' or private.mock_providers_allowed())
    order by q.as_of desc, q.reported_at desc, q.id desc
    limit 1;
end
$$;

create or replace function servicing.lender_loan_documents(p_loan uuid)
returns table (
  document_id uuid, kind text, issuer text, lender_reference text, issued_at timestamptz, period_from date, period_to date, size_bytes bigint,
  sha256 text, source text, superseded_by_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
begin
  select * into l from servicing.loan_accounts la where la.id = p_loan;
  if not found or not coalesce(l.lender_org_id in (select private.orgs_with_permission('loan.read')), false) then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  return query
    select d.id, d.kind, d.issuer, d.lender_reference, d.issued_at, d.period_from, d.period_to, d.size_bytes, d.sha256, d.source,
           (select s.id from servicing.loan_documents s where s.supersedes_id = d.id)
    from servicing.loan_documents d
    where d.loan_account_id = p_loan and (d.source <> 'mock' or private.mock_providers_allowed())
    order by d.issued_at desc, d.id;
end
$$;

create or replace function servicing.lender_open_loan_document(p_doc uuid, p_purpose text default 'view')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d servicing.loan_documents;
begin
  select * into d from servicing.loan_documents x where x.id = p_doc;
  -- Opening the content needs loan.read through a membership of THIS lender (a platform role that can read loan metadata cannot).
  if not found or not coalesce(private.user_has_permission_in_org((select auth.uid()), d.lender_org_id, 'loan.read'), false) then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  perform private.require_feature(d.lender_org_id, 'statements_noc');
  if p_purpose is null or p_purpose not in ('view', 'download') then
    raise exception 'invalid purpose' using errcode = '22023', hint = 'purpose_invalid';
  end if;
  if d.source = 'mock' and not private.mock_providers_allowed() then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  insert into servicing.loan_document_access (document_id, lender_org_id, actor_type, actor_user_id, purpose)
  values (d.id, d.lender_org_id, 'lender', (select auth.uid()), p_purpose);
  return jsonb_build_object('document_id', d.id, 'loan_account_id', d.loan_account_id, 'kind', d.kind, 'storage_key', d.storage_key, 'sha256', d.sha256,
                            'size_bytes', d.size_bytes, 'mime_type', d.mime_type, 'lender_reference', d.lender_reference, 'source', d.source);
end
$$;

-- Creates the release tasks for the collateral types the LENDER reported. Idempotent per (loan, type); returns how many were created.
-- A person needs servicing.document.issue; the system role may call it with the lender's reported types. Udofin never confirms.
create or replace function servicing.open_security_release_tasks(p_loan uuid, p_collateral_types text[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
  c servicing.closure_records;
  v_uid uuid;
  v_rule uuid;
  v_days integer;
  v_due timestamptz;
  v_n integer;
begin
  select * into l from servicing.loan_accounts la where la.id = p_loan;
  if not found then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  v_uid := private.servicing_docs_actor(l.lender_org_id, 'servicing.document.issue', true);
  perform private.require_feature(l.lender_org_id, 'statements_noc');
  if p_collateral_types is null or cardinality(p_collateral_types) not between 1 and 5
     or exists (select 1 from unnest(p_collateral_types) t where t is null or t not in ('mutual_fund_lien', 'demat_pledge', 'property_documents', 'vehicle_hypothecation', 'other'))
     or (select count(distinct t) from unnest(p_collateral_types) t) <> cardinality(p_collateral_types) then
    raise exception 'collateral types must be 1 to 5 distinct known values' using errcode = '22023', hint = 'collateral_types_invalid';
  end if;
  select * into c from servicing.closure_records x where x.loan_account_id = p_loan;
  if not found then
    raise exception 'the lender has not reported this loan closed' using errcode = '55000', hint = 'loan_not_closed';
  end if;
  -- The collateral the lender reported decides applicability, so the rule is resolved without the platform product category.
  select x.rule_id, x.days into v_rule, v_days
    from private.servicing_rule_days(l.lender_org_id, 'servicing.security_release_sla_days', null, private.servicing_ist_today()) x;
  if v_days is not null then v_due := c.closed_at + make_interval(days => v_days); else v_rule := null; end if;
  insert into servicing.security_release_tasks (lender_org_id, loan_account_id, closure_id, collateral_type, due_by, due_rule_id, opened_by)
  select l.lender_org_id, p_loan, c.id, t, v_due, v_rule, v_uid from unnest(p_collateral_types) t
  on conflict (loan_account_id, collateral_type) do nothing;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform private.servicing_docs_audit(l.lender_org_id, 'servicing.security_release.opened', 'closure_record', c.id::text,
      jsonb_build_object('loan_account_id', p_loan, 'tasks_created', v_n, 'due_rule_resolved', v_rule is not null));
  end if;
  return v_n;
end
$$;

-- Only a lender user holding servicing.document.issue, with the lender's own confirmation reference, can confirm a release.
-- Udofin (the system role, platform staff, a borrower) cannot.
create or replace function servicing.confirm_security_release(p_task uuid, p_confirmation_ref text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t servicing.security_release_tasks;
  v_uid uuid;
begin
  select * into t from servicing.security_release_tasks x where x.id = p_task;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  v_uid := private.servicing_docs_actor(t.lender_org_id, 'servicing.document.issue', false);
  perform private.require_feature(t.lender_org_id, 'statements_noc');
  if p_confirmation_ref is null or p_confirmation_ref !~ '^[A-Za-z0-9._/-]{3,100}$' then
    raise exception 'the lender''s confirmation reference is required' using errcode = '22023', hint = 'confirmation_ref_invalid';
  end if;
  if t.status <> 'open' then
    raise exception 'the task is already confirmed' using errcode = '55000', hint = 'already_confirmed';
  end if;
  update servicing.security_release_tasks
     set status = 'confirmed_by_lender', lender_confirmation_ref = p_confirmation_ref, confirmed_by = v_uid, confirmed_at = clock_timestamp()
   where id = p_task;
  perform private.servicing_docs_audit(t.lender_org_id, 'servicing.security_release.confirmed', 'security_release_task', p_task::text,
    jsonb_build_object('loan_account_id', t.loan_account_id, 'collateral_type', t.collateral_type));
  return 'confirmed_by_lender';
end
$$;

-- The lender's reason for a delay, shown to the borrower. Lender-supplied text; may be replaced while the task is open.
create or replace function servicing.set_security_release_delay_reason(p_task uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t servicing.security_release_tasks;
  v_uid uuid;
begin
  select * into t from servicing.security_release_tasks x where x.id = p_task;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  v_uid := private.servicing_docs_actor(t.lender_org_id, 'servicing.document.issue', false);
  perform private.require_feature(t.lender_org_id, 'statements_noc');
  if p_reason is null or length(trim(p_reason)) < 10 or length(trim(p_reason)) > 500 or not private.servicing_text_safe(trim(p_reason)) then
    raise exception 'a reason of 10 to 500 characters, without personal data, is required' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if t.status <> 'open' then
    raise exception 'the task is already confirmed' using errcode = '55000', hint = 'already_confirmed';
  end if;
  update servicing.security_release_tasks set delay_reason = trim(p_reason), delay_reason_by = v_uid, delay_reason_at = clock_timestamp() where id = p_task;
  perform private.servicing_docs_audit(t.lender_org_id, 'servicing.security_release.delay_reason_set', 'security_release_task', p_task::text,
    jsonb_build_object('loan_account_id', t.loan_account_id, 'collateral_type', t.collateral_type));
  return 'recorded';
end
$$;

-- ---------------------------------------------------------------------------------------------
-- I. System function: expire requests nobody answered before a cutoff the caller supplies (no age is hard-coded here).
-- ---------------------------------------------------------------------------------------------
create or replace function servicing.expire_document_requests(p_cutoff timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_n integer := 0;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_cutoff is null or p_cutoff > clock_timestamp() then
    raise exception 'the cutoff must be in the past' using errcode = '22023', hint = 'cutoff_invalid';
  end if;
  for r in
    update servicing.document_requests x set status = 'expired', decided_at = clock_timestamp()
     where x.status = 'requested' and x.requested_at < p_cutoff and private.feature_enabled(x.lender_org_id, 'statements_noc')
    returning x.id, x.lender_org_id, x.loan_account_id, x.kind
  loop
    v_n := v_n + 1;
    perform private.servicing_docs_audit(r.lender_org_id, 'servicing.document_request.expired', 'document_request', r.id::text,
      jsonb_build_object('loan_account_id', r.loan_account_id, 'kind', r.kind));
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- J. Grants and comments on functions
-- ---------------------------------------------------------------------------------------------
comment on function servicing.latest_valid_quote(uuid) is
  'Zero or one row: the newest unexpired foreclosure quotation of the loan as the lender reported it. Zero rows also when the statements_noc switch is off, the loan is unknown, or the caller may not see it. A foreclosure payment must equal the total of this row and must be refused when total_mismatch is true. Mock-source quotes count only where mock providers are allowed.';
comment on function servicing.confirm_security_release(uuid, text) is
  'Moves a security-release task to confirmed_by_lender. Only a lender user with servicing.document.issue (aal2) can call it; the table trigger enforces the same for any writer. Udofin never confirms a release.';
comment on function servicing.my_closure(uuid) is
  'Closure facts for the owning borrower with prompt KEYS only. A key says the lender will release or has confirmed; nothing here ever claims that Udofin or the app released anything.';

do $$
declare
  f text;
begin
  foreach f in array array[
    'servicing.request_document(uuid, text, text, date, date)', 'servicing.cancel_document_request(uuid)',
    'servicing.my_document_requests(uuid)', 'servicing.my_loan_documents(uuid)', 'servicing.open_loan_document(uuid, text)',
    'servicing.my_closure(uuid)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    'servicing.decline_document_request(uuid, text)', 'servicing.lender_loan_documents(uuid)', 'servicing.lender_open_loan_document(uuid, text)',
    'servicing.confirm_security_release(uuid, text)', 'servicing.set_security_release_delay_reason(uuid, text)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    'servicing.register_loan_document(uuid, text, text, text, bigint, text, text, timestamptz, date, date, uuid, uuid, text)',
    'servicing.record_foreclosure_quote(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, uuid, uuid)',
    'servicing.open_security_release_tasks(uuid, text[])', 'servicing.latest_valid_quote(uuid)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  execute 'revoke all on function servicing.expire_document_requests(timestamptz) from public, anon';
  execute 'grant execute on function servicing.expire_document_requests(timestamptz) to service_role';
end
$$;
