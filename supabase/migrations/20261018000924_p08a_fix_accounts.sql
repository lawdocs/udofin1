-- =============================================================================================
-- Phase 08a review fixes, stream SA: accounts registry, merchants, payment configurations, feature switches and activation.
-- Forward-only. Redefines only functions owned by this stream (migrations 20261018000908 to 910, 914, 915, 919 and set_lms_connection of
-- 911). No account, fingerprint, merchant, provider, owner or configuration is seeded. Error codes follow the repository convention
-- (42501 not authorised, P0002 not found, 22023 bad input, 55000 rule or state, 23505 duplicate, 23514 check or segregation).
--
--   A13  A platform or system hold on a payment configuration is sticky: only a platform function (providers.manage, aal2, a DIFFERENT
--        person than the one who set it) lifts it. The lender's maker and checker can neither re-submit nor re-approve it, cannot
--        activate another configuration of the same lender while a held one stands, and cannot retire a held one.
--   A14  A rejected or revoked LENDER-owned registry entry releases its fingerprint (uniqueness applies to live entries and to every
--        non-lender entry); revoked settlement accounts leave the duplicate match and the cap.
--   A15  request_settlement_account takes only the canonical masked reference (six X and four digits); withdraw_settlement_account.
--   A16  One personal-data screen for every free-text column of this stream (nine or more digits once spaces and hyphens are removed,
--        PAN and IFSC shapes, links, e-mail, secret assignments, phone and spaced Aadhaar shapes).
--   A17  The own-account list (accounts owned by Udofin and its group) must be attested complete, with an evidence reference, before a
--        lender account is verified or linked and before payments or mandates can be switched on.
--   A19  Merchant claims never reveal who holds an id, an unverified claim can be withdrawn, claims are capped, only ONE claim of an id
--        can be verified at a time.
--   A42  servicing.set_lms_connection records the file_import/manual connection before the servicing_sync switch is on.
--   M1   A key rotation re-links every settlement account to the verified successor of its entry; manual re-link as a fallback.
--   M4   Settlement-account requests are serialised per lender and unique among live rows.
--   M5   At most one ACTIVE payment configuration per lender.
--   M6   A long note raises the stable reason_invalid hint, never a raw check violation.
--   U41  provider_register: lenders read the vocabulary columns only; platform users read the rest through a view.
--   U46  Feature evidence keys have a fixed label shape.
--   U51  Secret names of a configuration live in a lender-specific namespace stored on the configuration.
--   U53  The tenancy change-control bypass through a session setting is closed.
--   U55  The separation-of-duties triggers serialise per login.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 0. One personal-data screen for the free-text columns of this stream (A16, M3, U37)
-- ---------------------------------------------------------------------------------------------
create or replace function private.acct_text_unsafe(p_text text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_text is not null and (
    -- Nine or more digits once spaces and hyphens are removed: an account, phone or identity number split by spaces or hyphens.
    regexp_replace(p_text, '[[:space:]-]', '', 'g') ~ '[0-9]{9,}'
    -- A PAN-shaped token and an IFSC-shaped token, in any letter case (\b is a backspace in these patterns: \m and \M are the word edges).
    or p_text ~* '\m[a-z]{5}[0-9]{4}[a-z]\M'
    or p_text ~* '\m[a-z]{4}0[a-z0-9]{6}\M'
    -- Links and e-mail addresses.
    or p_text ~* '(https?://|www\.)'
    or p_text ~* '\m[a-z0-9-]+\.(com|org|net|in|io|co|me|ly|app|link|dev|xyz|info|biz|gov|edu|ai)\M'
    or p_text ~ '@'
    -- The shapes the repository's other free-text guard (onboarding.reject_unsafe_text) already refuses.
    or p_text ~* '(password|passwd|secret|api[_ -]?key|private[_ -]?key|bearer|access[_ -]?token)\s*[:=]\s*\S{4,}'
    or p_text ~ '\m[2-9][0-9]{3}\s?[0-9]{4}\s?[0-9]{4}\M'
    or p_text ~ '(^|[^0-9])[6-9][0-9]{9}([^0-9]|$)')
$$;
comment on function private.acct_text_unsafe(text) is
  'True when a free-text value looks like it carries a personal identifier, an account number or a secret: nine or more digits after removing spaces and hyphens (the same rule as the contracts looksPersonal), a PAN or IFSC shape in any letter case, a link, an e-mail address, a secret assignment, a phone number or a spaced Aadhaar number. A guard rail, not a substitute for judgement. Used by private.acct_reject_unsafe_text and private.rail_limits_ok.';
revoke all on function private.acct_text_unsafe(text) from public;
grant execute on function private.acct_text_unsafe(text) to authenticated, service_role;

-- Row trigger: create trigger ... before insert or update on <table> for each row execute function private.acct_reject_unsafe_text('col', ...).
create or replace function private.acct_reject_unsafe_text()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_col text;
begin
  foreach v_col in array tg_argv loop
    if private.acct_text_unsafe(to_jsonb(new) ->> v_col) then
      raise exception 'column % looks like it contains a secret or a personal identifier; store a reference instead', v_col
        using errcode = '22023', hint = 'unsafe_free_text';
    end if;
  end loop;
  return new;
end
$$;
comment on function private.acct_reject_unsafe_text() is
  'Generic row trigger over private.acct_text_unsafe: the columns to check are the trigger arguments. 22023, hint unsafe_free_text. Same hint as onboarding.reject_unsafe_text.';
revoke all on function private.acct_reject_unsafe_text() from public;

-- A limit key (or an evidence key) is a fixed label: lower-case letters and underscores, at most two digits in all, so a key can never
-- carry a phone, account or identity number.
create or replace function private.acct_label_key_ok(p_key text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_key ~ '^[a-z][a-z0-9_]{1,40}$' and p_key !~ '[0-9]{3}' and length(regexp_replace(p_key, '[^0-9]', '', 'g')) <= 2
$$;
comment on function private.acct_label_key_ok(text) is 'A fixed label shape for keys that are copied into audit metadata or shown to lenders: letters and underscores with at most two digits in all.';
revoke all on function private.acct_label_key_ok(text) from public;
grant execute on function private.acct_label_key_ok(text) to authenticated, service_role;

-- Rail limits copied from provider documentation (M3 part 2). Keys are fixed labels; a string value is screened like any free text;
-- a value that is only digits (a money limit) is accepted, but nine or more digits are accepted only under a key that says it is money
-- in paise (ends in _minor): an account number cannot hide under another key.
create or replace function private.rail_limits_ok(p jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when p is not null and jsonb_typeof(p) = 'object' and octet_length(p::text) <= 4000 then
    not exists (
      select 1 from jsonb_each(p) top
      where not private.acct_label_key_ok(top.key)
         or jsonb_typeof(top.value) <> 'object'
         or case when jsonb_typeof(top.value) = 'object' then exists (
              select 1 from jsonb_each(top.value) leaf
              where not private.acct_label_key_ok(leaf.key)
                 or not (
                      (jsonb_typeof(leaf.value) = 'string' and length(leaf.value #>> '{}') between 1 and 100)
                   or jsonb_typeof(leaf.value) = 'boolean'
                   or (jsonb_typeof(leaf.value) = 'number' and (leaf.value #>> '{}') ~ '^[0-9]{1,15}$'))
                 or (jsonb_typeof(leaf.value) in ('string', 'number') and (leaf.value #>> '{}') ~ '^[0-9]{9,}$' and leaf.key !~ '_minor$')
                 or (jsonb_typeof(leaf.value) = 'string' and (leaf.value #>> '{}') !~ '^[0-9]+$' and private.acct_text_unsafe(leaf.value #>> '{}')))
            else true end)
  else false end
$$;
comment on function private.rail_limits_ok(jsonb) is
  'Rail limits copied from provider documentation: { "<rail>": { "<limit>": <string | boolean | non-negative integer> } }. Keys are fixed labels (private.acct_label_key_ok). Money limits are integers or digit strings, and nine or more digits only under a key ending _minor. A string value is screened with private.acct_text_unsafe. A source note is required by the table.';

-- Feature evidence (U46): the keys are copied into append-only audit metadata that lender users can read, so they have a fixed label
-- shape too. Everything else is as in the foundation.
create or replace function private.feature_evidence_ok(p_evidence jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when p_evidence is not null and jsonb_typeof(p_evidence) = 'object' then
    octet_length(p_evidence::text) <= 4000
    and (select count(*) from jsonb_object_keys(p_evidence)) <= 20
    and not exists (
      select 1 from jsonb_each(p_evidence) kv
      where not private.acct_label_key_ok(kv.key)
         or jsonb_typeof(kv.value) <> 'string'
         or length(kv.value #>> '{}') not between 1 and 200
         or (kv.value #>> '{}') ~* '(password|passwd|secret|api[_ -]?key|private[_ -]?key|bearer|access[_ -]?token)\s*[:=]\s*\S{4,}'
         or (kv.value #>> '{}') ~ '\m[2-9][0-9]{3}\s?[0-9]{4}\s?[0-9]{4}\M'
         or (kv.value #>> '{}') ~ '\m[A-Z]{5}[0-9]{4}[A-Z]\M'
         or (kv.value #>> '{}') ~ '(^|[^0-9])[6-9][0-9]{9}([^0-9]|$)'
         or (kv.value #>> '{}') ~ '[0-9]{11,}'
         or (kv.value #>> '{}') ~ '@')
  else false end
$$;
comment on function private.feature_evidence_ok(jsonb) is
  'Evidence for an activation switch: a flat object of short string references. Keys are fixed labels (letters and underscores, at most two digits in all: they are copied into audit metadata). Defence in depth, not a personal-data scanner.';

-- ---------------------------------------------------------------------------------------------
-- 1. Account registry: uniqueness over the entries that count (A14), text screens (M3), one attestation table (A17)
-- ---------------------------------------------------------------------------------------------
-- A rejected or revoked LENDER-owned entry releases its fingerprint, so a mistaken registration (wrong owner, purposes or dates) can be
-- corrected by registering the account again for the right owner; the dead row stays as history. An entry that is NOT lender-owned
-- (udofin, group_company, other) keeps its fingerprint for good, in every status: those entries exist so that the account is
-- RECOGNISED and refused for lenders, and revoking one must never let the same real account be registered as a lender's.
alter table payments.account_registry drop constraint account_registry_fingerprint_key_version_key;
create unique index account_registry_fingerprint_live on payments.account_registry (fingerprint, key_version)
  where verification_status in ('unverified', 'verified') or owner_kind <> 'lender';
create index account_registry_fingerprint_all on payments.account_registry (fingerprint, key_version);
-- The unique indexes are checked in the order they were created. Re-create the one-successor index after the fingerprint index so that a
-- second registration of the same account still reports account_already_registered before already_rekeyed (as before this migration).
drop index payments.account_registry_rekeyed_from;
create unique index account_registry_rekeyed_from on payments.account_registry (rekeyed_from_id) where rekeyed_from_id is not null;
comment on index payments.account_registry_fingerprint_live is
  'At most one registry entry per (fingerprint, key version) among entries that count: unverified or verified entries, and every entry that is not lender-owned (whatever its status). A rejected or revoked lender-owned entry releases the fingerprint. The fingerprint is a keyed hash of the bank code and the account number as typed: the same real account typed differently (leading zeros, a bank code changed by a merger) has another fingerprint, so this is a best-effort guard and the verifier''s evidence check stays the stated control.';
comment on table payments.account_registry is
  'Fail-closed registry of account fingerprints and who owns them (owner decision 3, 14 Oct 2026). Starts EMPTY: nothing is seeded, no account is assumed to belong to a lender because details were supplied. At most one entry per (fingerprint, key_version) counts at a time (a rejected or revoked lender-owned entry releases its fingerprint; a non-lender entry never does), so the same account, typed the same way, cannot sit under two owners. This is BEST EFFORT: the fingerprint is a keyed hash of the bank code and the account number as typed, so the same real account typed differently (leading zeros, a bank code changed by a merger) has a different fingerprint, and the human verifier''s evidence check remains the stated control. A new key_version means re-registration. owner_kind <> lender can never carry the repayment_settlement purpose. A verified entry needs a DIFFERENT person than the registrant and an evidence reference. Rows are never deleted; the only changes are unverified -> verified | rejected | revoked and verified -> revoked, each through payments.verify_account / reject_account / revoke_account. Readable only by platform users holding the registry permissions and by the validation functions; lenders see masked reference and status only through payments.my_settlement_account_registry_status. Owner: payments module.';

create trigger unsafe_text_acct before insert or update on payments.account_registry
  for each row execute function private.acct_reject_unsafe_text('legal_owner_name', 'evidence_ref', 'verification_note', 'rejection_reason', 'revoked_reason');
create trigger unsafe_text_acct before insert on payments.account_registry_events
  for each row execute function private.acct_reject_unsafe_text('evidence_ref', 'note');
create trigger unsafe_text_acct before insert on payments.lender_payment_config_events
  for each row execute function private.acct_reject_unsafe_text('note');
create trigger unsafe_text_acct before insert or update on payments.provider_register
  for each row execute function private.acct_reject_unsafe_text('display_name', 'authorisation_evidence_ref', 'status_reason');

-- Is a registry entry one that counts for uniqueness? (the same predicate as the index above)
create or replace function private.registry_entry_counts(p_entry payments.account_registry)
returns boolean
language sql
immutable
set search_path = ''
as $$ select p_entry.verification_status in ('unverified', 'verified') or p_entry.owner_kind <> 'lender' $$;
revoke all on function private.registry_entry_counts(payments.account_registry) from public;
grant execute on function private.registry_entry_counts(payments.account_registry) to authenticated, service_role;

-- Is p_new a re-keyed successor (directly or through several rotations) of p_old?
create or replace function private.registry_is_successor(p_old uuid, p_new uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive chain (id, depth) as (
    select r.id, 1 from payments.account_registry r where r.rekeyed_from_id = p_old
    union all
    select r.id, c.depth + 1 from payments.account_registry r join chain c on r.rekeyed_from_id = c.id where c.depth < 20)
  select exists (select 1 from chain where id = p_new)
$$;
comment on function private.registry_is_successor(uuid, uuid) is
  'True when p_new is the re-keyed successor of p_old (rekeyed_from_id chain, at most 20 rotations deep). Used by the settlement-account guard to allow the one change of the registry link that a key rotation needs.';
revoke all on function private.registry_is_successor(uuid, uuid) from public;
grant execute on function private.registry_is_successor(uuid, uuid) to authenticated, service_role;

-- The own-account list (accounts owned by Udofin and its group) must be attested complete before lender accounts are verified and
-- before payments or mandates can be switched on (A17). An append-only history; the latest event for the ACTIVE key version decides.
create table payments.own_account_attestations (
  id uuid primary key default private.uuid_v7(),
  event_kind text not null check (event_kind in ('attested', 'withdrawn')),
  key_version integer not null references payments.fingerprint_key_versions (key_version) on delete restrict,
  -- A reference label to what the attestor reconciled the list against (a finance register, a ticket). No file bytes, no account details.
  evidence_ref text check (evidence_ref is null or evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#,()-]{2,199}$'),
  reason text check (reason is null or length(reason) between 10 and 1000),
  -- How many VERIFIED entries owned by Udofin or a group company existed under that key version when it was attested.
  entries_counted integer check (entries_counted is null or entries_counted >= 0),
  actor_id uuid not null references auth.users (id),
  occurred_at timestamptz not null default clock_timestamp(),
  constraint attested_has_evidence check ((event_kind = 'attested') = (evidence_ref is not null and entries_counted is not null)),
  constraint withdrawn_has_reason check ((event_kind = 'withdrawn') = (reason is not null))
);
create index own_account_attestations_key on payments.own_account_attestations (key_version, occurred_at);
comment on table payments.own_account_attestations is
  'Append-only record that the list of accounts owned by Udofin and its group companies (owner_kind udofin or group_company in payments.account_registry) is loaded and COMPLETE for a fingerprint key version, with an evidence reference. Without it the guard "this account belongs to Udofin" can be vacuous (an unregistered Udofin account looks like any other account). The latest event for the ACTIVE key version decides (private.own_account_list_attested): a lender account cannot be verified or linked, and payments or mandates cannot be switched on, without a current attestation. A key rotation needs a fresh attestation under the new version. Nothing is seeded. Written only by payments.attest_own_account_list and payments.withdraw_own_account_list_attestation. Owner: payments module.';
create trigger unsafe_text_acct before insert on payments.own_account_attestations
  for each row execute function private.acct_reject_unsafe_text('evidence_ref', 'reason');
create trigger append_only before update or delete on payments.own_account_attestations
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.own_account_attestations
  for each statement execute function private.forbid_truncate();
alter table payments.own_account_attestations enable row level security;
alter table payments.own_account_attestations force row level security;
create policy own_account_attestations_read on payments.own_account_attestations for select to authenticated
  using ((select private.has_platform_permission('platform.accounts.registry.manage'))
         or (select private.has_platform_permission('platform.accounts.registry.verify')));
revoke all on payments.own_account_attestations from service_role;
grant select on payments.own_account_attestations to authenticated;

create or replace function private.own_account_list_attested()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select a.event_kind = 'attested'
    from payments.own_account_attestations a
    join payments.fingerprint_key_versions k on k.key_version = a.key_version and k.status = 'active'
    order by a.occurred_at desc, a.id desc
    limit 1), false)
$$;
comment on function private.own_account_list_attested() is
  'True when the latest own-account-list event for the ACTIVE fingerprint key version is an attestation (not a withdrawal). False when there is none, when no key version is active, or after a key rotation until the list is attested again.';
revoke all on function private.own_account_list_attested() from public;
grant execute on function private.own_account_list_attested() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Merchants: a claim is a CLAIM; only one claim of an id can be verified and active at a time (A19, M2, U52)
-- ---------------------------------------------------------------------------------------------
alter table payments.merchant_registry drop constraint merchant_registry_provider_merchant_ref_key;
create unique index merchant_registry_one_verified on payments.merchant_registry (provider, merchant_ref)
  where verification_status = 'verified' and status = 'active';
create unique index merchant_registry_one_live_claim on payments.merchant_registry (provider, merchant_ref, owner_org_id)
  where owner_kind = 'lender' and status = 'active';
create unique index merchant_registry_one_fee_merchant on payments.merchant_registry (provider, merchant_ref)
  where owner_kind = 'udofin_fees' and status = 'active';
create index merchant_registry_ref on payments.merchant_registry (provider, merchant_ref);
comment on table payments.merchant_registry is
  'Provider merchant identifiers and who owns them: a lender (purpose repayment) or Udofin''s own fee-collection merchant (owner_kind udofin_fees, purpose fee_collection). A lender CLAIMS an id (several lenders can claim the same id, so a claim reveals nothing about who else holds it); a platform user VERIFIES one claim against evidence, and at most ONE active claim of a (provider, merchant_ref) can be verified at a time (unique partial index). A revoked or withdrawn claim stays as history and frees nothing but its own slot; a platform revocation of the verified claim releases the id for another verification. A payment configuration can only reference a merchant of its own lender (composite key), so Udofin''s fee merchant can never be used for repayments. Nothing is seeded. Written only by payments.claim_merchant / withdraw_merchant_claim / verify_merchant / register_udofin_fee_merchant / revoke_merchant. Owner: payments module.';
create trigger unsafe_text_acct before insert or update on payments.merchant_registry
  for each row execute function private.acct_reject_unsafe_text('verification_evidence_ref', 'revoked_reason');

-- ---------------------------------------------------------------------------------------------
-- 3. Settlement accounts: unique among live rows (M4), text screens (A16), re-link along a key rotation (M1)
-- ---------------------------------------------------------------------------------------------
create unique index lender_settlement_accounts_live on tenancy.lender_settlement_accounts (lender_org_id, lower(bank_name), masked_account_ref)
  where status <> 'revoked';
create trigger unsafe_text_acct before insert or update on tenancy.lender_settlement_accounts
  for each row execute function private.acct_reject_unsafe_text('label', 'bank_name');

-- ---------------------------------------------------------------------------------------------
-- 4. Payment configurations: sticky hold (A13), one active per lender (M5), secret namespace (U51), text screens (M3)
-- ---------------------------------------------------------------------------------------------
alter table payments.lender_payment_configs
  add column hold_kind text check (hold_kind in ('platform', 'system')),
  add column hold_set_by uuid references auth.users (id),
  add column hold_set_at timestamptz,
  add column secret_namespace text check (secret_namespace is null or secret_namespace ~ '^L[0-9A-F]{12}_$');
alter table payments.lender_payment_configs
  add constraint hold_is_whole check (
    (hold_kind is null) = (hold_set_at is null)
    and (hold_kind is distinct from 'platform' or hold_set_by is not null)
    and (hold_kind is distinct from 'system' or hold_set_by is null)),
  add constraint hold_only_when_suspended_or_retired check (hold_kind is null or status in ('suspended', 'retired')),
  add constraint secrets_in_namespace check (
    secret_namespace is null or (starts_with(secret_ref, secret_namespace) and starts_with(webhook_secret_ref, secret_namespace)));
create unique index lender_payment_configs_one_active on payments.lender_payment_configs (lender_org_id) where status = 'active';
create index lender_payment_configs_held on payments.lender_payment_configs (lender_org_id) where status = 'suspended' and hold_kind is not null;
comment on column payments.lender_payment_configs.hold_kind is
  'Who put this configuration on hold: platform (a platform user used the kill switch, payments.suspend_payment_config) or system (payments.system_suspend_payment_config or the nightly revalidation). While a hold stands the lender can neither re-submit nor re-approve it, cannot retire it, and cannot activate any other configuration of the same lender; only payments.release_payment_config_hold (platform.payments.providers.manage, aal2, a DIFFERENT person than the one who set a platform hold) lifts it.';
comment on column payments.lender_payment_configs.secret_namespace is
  'The lender-specific prefix every secret name of this configuration starts with (payments.secret_ref_prefix). Set by payments.draft_payment_config; null only for rows written before the rule or by fixtures. RESOLVERS (the worker and the callback receiver) must read a secret only when secret_namespace is not null, equals payments.secret_ref_prefix(lender_org_id) and both secret_ref and webhook_secret_ref start with it; any other name must resolve to nothing, and no platform secret may ever be named with a prefix of the form L + 12 hexadecimal digits + underscore.';
comment on index payments.lender_payment_configs_one_active is
  'At most ONE active payment configuration per lender: payments and mandates choose the lender''s configuration by counting the active ones and refuse (config_ambiguous) when there is more than one.';
create trigger unsafe_text_acct before insert or update on payments.lender_payment_configs
  for each row execute function private.acct_reject_unsafe_text('evidence_ref', 'contract_section_ref', 'status_reason', 'rail_limits_source');

-- The lender-specific prefix of the secret names of a payment configuration (U51). The last twelve hexadecimal digits of a UUID v7 are
-- random, so two lenders never share a prefix.
create or replace function private.secret_ref_prefix(p_lender uuid)
returns text
language sql
immutable
set search_path = ''
as $$ select 'L' || upper(right(replace(p_lender::text, '-', ''), 12)) || '_' $$;
comment on function private.secret_ref_prefix(uuid) is 'L + the last twelve hexadecimal digits of the lender id + underscore: the namespace of every secret name a payment configuration of that lender may use.';
revoke all on function private.secret_ref_prefix(uuid) from public;
grant execute on function private.secret_ref_prefix(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Provider register: lenders read the vocabulary only (U41)
-- ---------------------------------------------------------------------------------------------
revoke select on payments.provider_register from authenticated;
grant select (provider, display_name, kind, status) on payments.provider_register to authenticated;
create view payments.provider_register_platform with (security_barrier = true) as
  select p.provider, p.display_name, p.kind, p.status, p.authorisation_evidence_ref, p.evidence_label, p.status_reason, p.updated_by, p.created_at, p.updated_at
  from payments.provider_register p
  where (select private.has_platform_permission('platform.payments.providers.manage'));
comment on view payments.provider_register_platform is
  'The whole provider register for platform users holding platform.payments.providers.manage (authorisation evidence references, status reasons, who changed it); nobody else gets a row. Lenders read only provider, display_name, kind and status from payments.provider_register itself (column privileges). Owner: payments module.';
revoke all on payments.provider_register_platform from public, anon, service_role;
grant select on payments.provider_register_platform to authenticated;
comment on table payments.provider_register is
  'Platform register of payment and mandate providers and the evidence of their authorisation (spec 7.1 step 4, PAY-05). A configuration may use a provider only while it is approved; a PRODUCTION configuration additionally needs authorisation_evidence_ref. Nothing is seeded: no provider has been chosen (D-65). Written only by payments.set_payment_provider (platform.payments.providers.manage). Staff of any organisation can read only the vocabulary columns (provider, display_name, kind, status); the evidence reference, the status reason and who changed it are readable through payments.provider_register_platform by platform.payments.providers.manage only. Owner: payments module.';
create or replace function payments.register_account(
  p_fingerprint text, p_key_version integer, p_masked_ref text, p_country text, p_account_type text, p_format_rule_id uuid,
  p_format_validated boolean, p_owner_kind text, p_owner_org_id uuid, p_legal_owner_name text, p_permitted_purposes text[],
  p_effective_from date, p_effective_to date, p_idempotency_key text,
  p_other_fingerprints jsonb default '{}'::jsonb, p_rekeys uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.manage']);
  v_from date := coalesce(p_effective_from, private.today_ist());
  v_existing payments.account_registry;
  v_rule payments.account_format_rules;
  v_ks payments.fingerprint_key_versions;
  v_other jsonb := coalesce(p_other_fingerprints, '{}'::jsonb);
  v_pred payments.account_registry;
  v_hit payments.account_registry;
  v_ver record;
  v_id uuid;
  v_constraint text;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 16 and 128 then
    raise exception 'a 16 to 128 character idempotency key is required' using errcode = '22023', hint = 'bad_request';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'the fingerprint must be 64 lowercase hex characters' using errcode = '22023', hint = 'fingerprint_invalid';
  end if;
  if p_key_version is null or p_key_version < 1 then
    raise exception 'the key version must be 1 or more' using errcode = '22023', hint = 'key_version_invalid';
  end if;
  if p_masked_ref is null or p_masked_ref !~ '^[X*]{2,}[0-9]{4}$' then
    raise exception 'the masked reference must show the last four digits only' using errcode = '22023', hint = 'masked_ref_invalid';
  end if;
  if p_owner_kind is null or p_owner_kind not in ('lender', 'udofin', 'group_company', 'other') then
    raise exception 'unknown owner kind' using errcode = '22023', hint = 'owner_invalid';
  end if;
  if (p_owner_kind = 'lender') <> (p_owner_org_id is not null) then
    raise exception 'a lender-owned account needs the lender organisation; other owners must not name one' using errcode = '22023', hint = 'owner_invalid';
  end if;
  if p_owner_kind = 'lender' and not exists (select 1 from tenancy.organizations o where o.id = p_owner_org_id and o.kind = 'lender') then
    raise exception 'the owner organisation is not a lender' using errcode = '22023', hint = 'owner_invalid';
  end if;
  if p_legal_owner_name is null or length(trim(p_legal_owner_name)) not between 3 and 200 then
    raise exception 'the legal owner name (a legal entity, never an individual) must be 3 to 200 characters' using errcode = '22023', hint = 'legal_owner_name_invalid';
  end if;
  if not private.account_purposes_ok(p_permitted_purposes)
     or (p_owner_kind <> 'lender' and 'repayment_settlement' = any (p_permitted_purposes)) then
    raise exception 'invalid permitted purposes (only a lender-owned account can be permitted for repayment settlement)' using errcode = '22023', hint = 'purposes_invalid';
  end if;
  if p_effective_to is not null and p_effective_to <= v_from then
    raise exception 'effective_to must be after effective_from' using errcode = '22023', hint = 'dates_invalid';
  end if;

  select * into v_existing from payments.account_registry r where r.registered_by = v_uid and r.idempotency_key = p_idempotency_key;
  if found then
    if (v_existing.fingerprint, v_existing.key_version, v_existing.owner_kind, v_existing.owner_org_id, v_existing.permitted_purposes, v_existing.format_rule_id)
       is distinct from (p_fingerprint, p_key_version, p_owner_kind, p_owner_org_id, p_permitted_purposes, p_format_rule_id) then
      raise exception 'idempotency key was already used for a different registration' using errcode = '23505', hint = 'idempotency_conflict';
    end if;
    return v_existing.id;
  end if;

  -- Key version. Fail closed: only the ACTIVE version takes a new registration, and the PROPOSED one takes only a re-keyed entry of an
  -- account already registered under the active version (the rotation path). The backend computes the fingerprint of the same account
  -- under every other live version and passes them in p_other_fingerprints ({"<version>": "<fingerprint>"}); an account already
  -- registered under another live key is refused unless this call is its re-key. The database never sees the account number.
  select * into v_ks from payments.fingerprint_key_versions k where k.key_version = p_key_version;
  if not found or v_ks.status = 'retired' then
    raise exception 'this fingerprint key version is not in force' using errcode = '55000', hint = 'key_version_not_allowed';
  end if;
  if v_ks.status = 'proposed' and p_rekeys is null then
    raise exception 'a proposed key version takes only the re-key of an existing entry' using errcode = '55000', hint = 'key_version_not_active';
  end if;
  if v_ks.status = 'active' and p_rekeys is not null then
    raise exception 're-keying targets the proposed key version' using errcode = '22023', hint = 'rekey_invalid';
  end if;
  if jsonb_typeof(v_other) <> 'object' then
    raise exception 'other fingerprints must be an object of version to fingerprint' using errcode = '22023', hint = 'other_fingerprints_invalid';
  end if;
  for v_ver in select k.key_version from payments.fingerprint_key_versions k where k.status <> 'retired' and k.key_version <> p_key_version loop
    if jsonb_typeof(v_other -> v_ver.key_version::text) is distinct from 'string' or (v_other ->> v_ver.key_version::text) !~ '^[0-9a-f]{64}$' then
      raise exception 'the fingerprint of the same account under every other live key version is required' using errcode = '22023', hint = 'other_fingerprints_incomplete';
    end if;
  end loop;
  if exists (select 1 from jsonb_object_keys(v_other) k
              where not exists (select 1 from payments.fingerprint_key_versions kv
                                 where kv.key_version::text = k and kv.status <> 'retired' and kv.key_version <> p_key_version)) then
    raise exception 'other fingerprints name a key version that is retired, unknown or the same as the one registered' using errcode = '22023', hint = 'other_fingerprints_invalid';
  end if;
  for v_ver in select e.key as version, e.value #>> '{}' as fp from jsonb_each(v_other) e loop
    -- Only an entry that counts (unverified, verified, or not lender-owned) occupies a fingerprint: a released lender entry is history.
    select * into v_hit from payments.account_registry r
     where r.fingerprint = v_ver.fp and r.key_version = v_ver.version::integer and private.registry_entry_counts(r);
    if found then
      if p_rekeys is not null and v_hit.id = p_rekeys then
        v_pred := v_hit;
      else
        raise exception 'this account is already registered under another key version' using errcode = '23505', hint = 'account_registered_under_other_key';
      end if;
    end if;
  end loop;
  if p_rekeys is not null then
    if v_pred.id is null then
      raise exception 'the entry to re-key does not match this account' using errcode = '22023', hint = 'rekey_invalid';
    end if;
    if v_pred.verification_status not in ('unverified', 'verified') then
      raise exception 'only a live entry can be re-keyed' using errcode = '22023', hint = 'rekey_invalid';
    end if;
    if (v_pred.owner_kind, v_pred.owner_org_id, v_pred.country, v_pred.account_type)
       is distinct from (p_owner_kind, p_owner_org_id, p_country, p_account_type) then
      raise exception 'a re-keyed entry keeps the owner, country and account type of the original' using errcode = '22023', hint = 'rekey_owner_mismatch';
    end if;
  end if;

  -- The number was validated against an APPROVED, effective rule before it was fingerprinted: the API attests that, the
  -- database cannot check digits it never sees. Fail closed: no rule, a rule that is not approved or not effective, a rule
  -- for another country or account type, or no attestation: refused.
  select * into v_rule from payments.account_format_rules r where r.id = p_format_rule_id;
  if p_format_rule_id is null or not found or p_format_validated is distinct from true
     or v_rule.status <> 'approved' or v_rule.country <> p_country or v_rule.account_type <> p_account_type
     or private.today_ist() < v_rule.effective_from
     or (v_rule.effective_to is not null and private.today_ist() >= v_rule.effective_to) then
    raise exception 'the account format was not validated against an approved rule' using errcode = '55000', hint = 'account_format_unvalidated';
  end if;

  begin
    insert into payments.account_registry (fingerprint, key_version, rekeyed_from_id, masked_ref, country, account_type, format_rule_id, format_validated,
                                           owner_kind, owner_org_id, legal_owner_name, permitted_purposes, effective_from, effective_to,
                                           registered_by, idempotency_key)
    values (p_fingerprint, p_key_version, v_pred.id, p_masked_ref, p_country, p_account_type, p_format_rule_id, true,
            p_owner_kind, p_owner_org_id, trim(p_legal_owner_name), p_permitted_purposes, v_from, p_effective_to, v_uid, p_idempotency_key)
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'account_registry_fingerprint_live' then
      raise exception 'this account is already registered' using errcode = '23505', hint = 'account_already_registered';
    elsif v_constraint = 'account_registry_rekeyed_from' then
      raise exception 'this entry was already re-keyed' using errcode = '23505', hint = 'already_rekeyed';
    end if;
    raise exception 'idempotency key was already used for a different registration' using errcode = '23505', hint = 'idempotency_conflict';
  end;
  perform private.write_payments_audit(p_owner_org_id, 'payments.account_registry.registered', 'account_registry', v_id::text,
    jsonb_build_object('owner_kind', p_owner_kind, 'key_version', p_key_version, 'purposes', to_jsonb(p_permitted_purposes), 'format_rule_id', p_format_rule_id,
                       'rekeys', p_rekeys));
  return v_id;
end
$$;
create or replace function private.classify_destination_impl(p_fingerprint text, p_key_version integer, p_lender uuid, p_purpose text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_entry payments.account_registry;
begin
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' or p_key_version is null or p_key_version < 1 or p_lender is null
     or p_purpose is null or p_purpose not in ('repayment_settlement', 'fee_collection', 'disbursement_source', 'operational') then
    return jsonb_build_object('decision', 'refused', 'reasons', jsonb_build_array('input_invalid'));
  end if;
  -- The entry that counts first; a released (rejected or revoked) lender entry only when nothing counts, so a dead entry still reads as
  -- rejected or revoked, never as unknown.
  select * into v_entry from payments.account_registry r where r.fingerprint = p_fingerprint and r.key_version = p_key_version
   order by private.registry_entry_counts(r) desc, r.registered_at desc, r.id desc limit 1;
  if not found then
    return jsonb_build_object('decision', 'refused', 'reasons', jsonb_build_array('account_unknown'));
  end if;
  return private.classify_registry_entry(v_entry, p_lender, p_purpose);
end
$$;
create or replace function payments.approve_fingerprint_key_version(p_version integer, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.verify']);
  v_k payments.fingerprint_key_versions;
  v_old payments.fingerprint_key_versions;
  v_uncovered bigint;
  v_row record;
  v_relinked integer := 0;
begin
  if p_note is not null and length(p_note) > 1000 then
    raise exception 'a note is at most 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into v_k from payments.fingerprint_key_versions k where k.key_version = p_version for update;
  if not found then
    raise exception 'key version not found' using errcode = 'P0002';
  end if;
  if v_k.status <> 'proposed' then
    raise exception 'only a proposed key version can be approved' using errcode = '55000', hint = 'not_proposed';
  end if;
  if v_k.proposed_by = v_uid then
    raise exception 'a different login must approve the key version' using errcode = '42501', hint = 'segregation_of_duties';
  end if;
  select * into v_old from payments.fingerprint_key_versions k where k.status = 'active' for update;
  if found then
    -- Every entry that still counts (unverified or verified) must have been re-registered under the new key, by its successor, and a
    -- successor of a VERIFIED entry must itself be verified (by a different person, on evidence) so the rotation never weakens a
    -- verified account into a held one without anyone noticing. Revoked and rejected entries stay refused and need no successor.
    select count(*) into v_uncovered from payments.account_registry r
     where r.key_version = v_old.key_version and r.verification_status in ('unverified', 'verified')
       and not exists (select 1 from payments.account_registry s
                        where s.rekeyed_from_id = r.id and s.key_version = v_k.key_version
                          and s.verification_status = case r.verification_status when 'verified' then 'verified' else s.verification_status end
                          and s.verification_status in ('unverified', 'verified'));
    if v_uncovered > 0 then
      raise exception 'registry entries under the current key have not been re-keyed' using errcode = '55000', hint = 'rotation_incomplete';
    end if;
    update payments.fingerprint_key_versions set status = 'retired', retired_by = v_uid, retired_at = clock_timestamp() where key_version = v_old.key_version;
  end if;
  update payments.fingerprint_key_versions set status = 'active', approved_by = v_uid, approved_at = clock_timestamp(),
         note = coalesce(p_note, note) where key_version = p_version;
  -- A rotation must not orphan the settlement accounts (M1): every verified account that points at an entry of the old key moves to the
  -- verified successor of that entry, in the same transaction, once the new key is the active one (the successor classifies as permitted
  -- only now). An account whose successor is not permitted yet stays where it was; payments.link_settlement_account re-links it later.
  if v_old.key_version is not null then
    for v_row in
      with moved as (
        update tenancy.lender_settlement_accounts s set registry_id = succ.id
        from payments.account_registry prev, payments.account_registry succ
        where s.registry_id = prev.id and prev.key_version = v_old.key_version
          and succ.rekeyed_from_id = prev.id and succ.key_version = p_version and succ.verification_status = 'verified'
          and succ.owner_org_id = s.lender_org_id and succ.masked_ref = s.masked_account_ref and s.status = 'verified'
          and private.classify_registry_entry(succ, s.lender_org_id, 'repayment_settlement') ->> 'decision' = 'permitted'
        returning s.id, s.lender_org_id, succ.id as registry_id)
      select * from moved
    loop
      v_relinked := v_relinked + 1;
      perform private.write_payments_audit(v_row.lender_org_id, 'payments.settlement_account.relinked', 'settlement_account', v_row.id::text,
        jsonb_build_object('registry_id', v_row.registry_id, 'key_version', p_version));
    end loop;
  end if;
  perform private.write_payments_audit(null, 'payments.fingerprint_key.activated', 'fingerprint_key_version', p_version::text,
    jsonb_build_object('retired', v_old.key_version, 'relinked', v_relinked));
  return 'active';
end
$$;
create or replace function payments.verify_account(p_registry uuid, p_evidence_ref text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.verify']);
  v_entry payments.account_registry;
begin
  select * into v_entry from payments.account_registry r where r.id = p_registry for update;
  if not found then
    raise exception 'registry entry not found' using errcode = 'P0002';
  end if;
  if v_entry.verification_status = 'verified' and v_entry.verified_by = v_uid and v_entry.evidence_ref is not distinct from p_evidence_ref then
    return 'verified';
  end if;
  if v_entry.verification_status <> 'unverified' then
    raise exception 'registry entry is %, not unverified', v_entry.verification_status using errcode = '55000', hint = 'not_unverified';
  end if;
  if v_entry.registered_by = v_uid then
    raise exception 'an account cannot be verified by the person who registered it' using errcode = '42501', hint = 'self_approval';
  end if;
  if p_evidence_ref is null or p_evidence_ref !~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#,()-]{2,199}$' then
    raise exception 'an evidence reference label is required (no file contents, no account details)' using errcode = '22023', hint = 'evidence_invalid';
  end if;
  if p_note is not null and length(p_note) > 1000 then
    raise exception 'a note must be at most 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if not private.user_holds_platform_permission(v_entry.registered_by, 'platform.accounts.registry.manage') then
    raise exception 'the registrant no longer holds the permission needed for this registration' using errcode = '42501', hint = 'requester_not_entitled';
  end if;
  if v_entry.effective_to is not null and private.today_ist() >= v_entry.effective_to then
    raise exception 'the registration is no longer effective' using errcode = '55000', hint = 'not_effective';
  end if;
  -- A lender's account is verified only while the list of Udofin and group accounts is attested complete (A17): otherwise the guard
  -- "this account belongs to Udofin" can be vacuous. Entries of Udofin, a group company or anyone else build that list and need no attestation.
  if v_entry.owner_kind = 'lender' and not private.own_account_list_attested() then
    raise exception 'the list of accounts owned by Udofin and its group has not been attested complete'
      using errcode = '55000', hint = 'own_account_list_not_attested';
  end if;
  update payments.account_registry
  set verification_status = 'verified', verified_by = v_uid, verified_at = now(), evidence_ref = p_evidence_ref, verification_note = p_note
  where id = p_registry;
  perform private.write_payments_audit(v_entry.owner_org_id, 'payments.account_registry.verified', 'account_registry', p_registry::text,
    jsonb_build_object('owner_kind', v_entry.owner_kind, 'registered_by', v_entry.registered_by));
  return 'verified';
end
$$;
-- SECURITY DEFINER (M7): the proof reads the registry, which the system role cannot read. As an invoker function the guard failed with a
-- bare permission error for every system-role write that named a registry entry, instead of judging the proof as the comment promises.
create or replace function private.guard_settlement_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry payments.account_registry;
  v_class jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.lender_org_id <> old.lender_org_id then
      raise exception 'a settlement account cannot move to another lender' using errcode = 'P0001';
    end if;
    -- The link is permanent except for ONE move: a key rotation re-keys the entry (rekeyed_from_id), and a verified account follows its
    -- entry to the verified successor owned by the same lender with the same masked reference (M1).
    if old.registry_id is not null and new.registry_id is distinct from old.registry_id
       and not (old.status = 'verified' and new.status = 'verified' and private.registry_is_successor(old.registry_id, new.registry_id)
                and exists (select 1 from payments.account_registry s
                             where s.id = new.registry_id and s.verification_status = 'verified' and s.owner_org_id = new.lender_org_id
                               and s.masked_ref = new.masked_account_ref)) then
      raise exception 'the registry link of a settlement account is permanent: register a new account instead' using errcode = 'P0001';
    end if;
    if old.registry_id is not null and new.masked_account_ref <> old.masked_account_ref then
      raise exception 'the masked reference of a registered settlement account cannot change' using errcode = 'P0001';
    end if;
    if old.status = 'revoked' and new.status <> 'revoked' then
      raise exception 'a revoked settlement account is final' using errcode = 'P0001';
    end if;
  end if;
  -- `verified` needs the proof, and needs it again whenever the row becomes verified (insert or transition).
  if new.status = 'verified' and (tg_op = 'INSERT' or old.status <> 'verified') then
    if new.registry_id is null then
      raise exception 'a settlement account becomes verified only through a verified registry entry' using errcode = '55000', hint = 'settlement_account_unproven';
    end if;
    select * into v_entry from payments.account_registry r where r.id = new.registry_id;
    if not found then
      raise exception 'registry entry not found' using errcode = '55000', hint = 'settlement_account_unproven';
    end if;
    if v_entry.verification_status <> 'verified' then
      raise exception 'the registry entry is not verified' using errcode = '55000', hint = 'settlement_account_unproven';
    end if;
    v_class := private.classify_registry_entry(v_entry, new.lender_org_id, 'repayment_settlement');
    if v_class ->> 'decision' <> 'permitted' then
      raise exception 'the registry entry does not permit repayment settlement for this lender: %', v_class ->> 'reasons'
        using errcode = '55000', hint = 'settlement_account_unproven';
    end if;
    if v_entry.masked_ref <> new.masked_account_ref then
      raise exception 'the masked reference differs from the registry entry' using errcode = '55000', hint = 'masked_ref_mismatch';
    end if;
  end if;
  return new;
end
$$;
create or replace function payments.draft_payment_config(
  p_lender uuid, p_provider text, p_provider_mode text, p_merchant_registry_id uuid, p_settlement_account_id uuid, p_secret_ref text,
  p_webhook_secret_ref text, p_endpoint_token_hash text, p_rail_limits jsonb, p_rail_limits_source text, p_evidence_ref text,
  p_contract_section_ref text, p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.payments_require_lender(p_lender, 'payment.configure');
  v_existing payments.lender_payment_configs;
  v_limits jsonb := coalesce(p_rail_limits, '{}'::jsonb);
  v_prefix text := private.secret_ref_prefix(p_lender);
  v_id uuid;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 16 and 128 then
    raise exception 'a 16 to 128 character idempotency key is required' using errcode = '22023', hint = 'bad_request';
  end if;
  -- Mock and sandbox only where the session allows it (22023 provider_mode_invalid, 42501 mock_provider_blocked / sandbox_provider_blocked).
  perform private.assert_provider_mode_allowed(p_provider_mode);
  -- Secret NAMES, different from each other, inside the lender's own namespace (U51): the worker and the callback receiver resolve them
  -- against the process environment, so a lender must not be able to name another lender's secret or a platform secret.
  if p_secret_ref is null or p_secret_ref !~ ('^' || v_prefix || '[A-Z][A-Z0-9_]{1,48}$')
     or p_webhook_secret_ref is null or p_webhook_secret_ref !~ ('^' || v_prefix || '[A-Z][A-Z0-9_]{1,48}$')
     or p_secret_ref = p_webhook_secret_ref then
    raise exception 'secret references are names of secrets (UPPER_CASE) inside the lender namespace (payments.secret_ref_prefix), different from each other'
      using errcode = '22023', hint = 'secret_ref_invalid';
  end if;
  if p_endpoint_token_hash is null or p_endpoint_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'the endpoint token hash must be 64 lowercase hex characters' using errcode = '22023', hint = 'endpoint_token_hash_invalid';
  end if;
  if not private.rail_limits_ok(v_limits) or (v_limits <> '{}'::jsonb and (p_rail_limits_source is null or length(trim(p_rail_limits_source)) < 10)) then
    raise exception 'rail limits must be an object of objects with a source note' using errcode = '22023', hint = 'rail_limits_invalid';
  end if;
  if not exists (select 1 from payments.provider_register r where r.provider = p_provider and r.kind in ('payment', 'payment_and_mandate')) then
    raise exception 'unknown provider, or one that is not registered for payments' using errcode = '22023', hint = 'provider_invalid';
  end if;
  if not exists (select 1 from payments.merchant_registry m where m.id = p_merchant_registry_id and m.owner_org_id = p_lender) then
    raise exception 'the merchant is not registered to this lender' using errcode = '22023', hint = 'merchant_invalid';
  end if;
  if not exists (select 1 from tenancy.lender_settlement_accounts s where s.id = p_settlement_account_id and s.lender_org_id = p_lender) then
    raise exception 'the settlement account is not this lender''s' using errcode = '22023', hint = 'settlement_account_invalid';
  end if;

  select * into v_existing from payments.lender_payment_configs c where c.drafted_by = v_uid and c.idempotency_key = p_idempotency_key;
  if found then
    if (v_existing.lender_org_id, v_existing.provider, v_existing.provider_mode, v_existing.merchant_registry_id, v_existing.settlement_account_id,
        v_existing.secret_ref, v_existing.webhook_secret_ref, v_existing.endpoint_token_hash)
       is distinct from (p_lender, p_provider, p_provider_mode, p_merchant_registry_id, p_settlement_account_id, p_secret_ref, p_webhook_secret_ref, p_endpoint_token_hash) then
      raise exception 'idempotency key was already used for a different configuration' using errcode = '23505', hint = 'idempotency_conflict';
    end if;
    return v_existing.id;
  end if;
  begin
    insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref,
                                                 webhook_secret_ref, secret_namespace, endpoint_token_hash, rail_limits, rail_limits_source, evidence_ref,
                                                 contract_section_ref, idempotency_key, drafted_by, status_changed_by)
    values (p_lender, p_provider, p_provider_mode, p_merchant_registry_id, p_settlement_account_id, p_secret_ref, p_webhook_secret_ref, v_prefix,
            p_endpoint_token_hash, v_limits, p_rail_limits_source, p_evidence_ref, p_contract_section_ref, p_idempotency_key, v_uid, v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'the callback token is already in use' using errcode = '23505', hint = 'endpoint_token_in_use';
  end;
  perform private.write_payments_audit(p_lender, 'payments.config.drafted', 'payment_config', v_id::text,
    jsonb_build_object('provider', p_provider, 'provider_mode', p_provider_mode));
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. Linking: needs the attested own-account list (A17); re-links an account along a key rotation (M1)
-- ---------------------------------------------------------------------------------------------
create or replace function payments.link_settlement_account(p_account uuid, p_registry uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.manage']);
  v_sa tenancy.lender_settlement_accounts;
  v_entry payments.account_registry;
  v_class jsonb;
  v_relink boolean := false;
begin
  select * into v_sa from tenancy.lender_settlement_accounts s where s.id = p_account for update;
  if not found then
    raise exception 'settlement account not found' using errcode = 'P0002';
  end if;
  select * into v_entry from payments.account_registry r where r.id = p_registry for share;
  if not found then
    raise exception 'registry entry not found' using errcode = 'P0002';
  end if;
  if v_sa.registry_id = p_registry and v_sa.status = 'verified' then
    return 'verified';
  end if;
  if v_sa.registry_id is not null then
    -- The one permitted move: the account points at an entry under a RETIRED key version and p_registry is its re-keyed successor (a key
    -- rotation whose automatic re-link could not move it, for example because the successor was not effective yet).
    if v_sa.status = 'verified' and private.registry_is_successor(v_sa.registry_id, p_registry)
       and not exists (select 1 from payments.account_registry o join payments.fingerprint_key_versions k on k.key_version = o.key_version
                        where o.id = v_sa.registry_id and k.status = 'active') then
      v_relink := true;
    else
      raise exception 'the settlement account is already linked to a registry entry' using errcode = '55000', hint = 'already_linked';
    end if;
  end if;
  if v_sa.status = 'revoked' then
    raise exception 'a revoked settlement account cannot be linked' using errcode = '55000', hint = 'settlement_account_revoked';
  end if;
  if v_entry.verification_status <> 'verified' then
    raise exception 'the registry entry is not verified' using errcode = '55000', hint = 'registry_not_permitted';
  end if;
  v_class := private.classify_registry_entry(v_entry, v_sa.lender_org_id, 'repayment_settlement');
  if v_class ->> 'decision' <> 'permitted' then
    raise exception 'the registry entry does not permit repayment settlement for this lender: %', v_class ->> 'reasons'
      using errcode = '55000', hint = 'registry_not_permitted';
  end if;
  if v_entry.masked_ref <> v_sa.masked_account_ref then
    raise exception 'the masked reference differs from the registry entry' using errcode = '55000', hint = 'masked_ref_mismatch';
  end if;
  -- A lender's account is linked only while the list of Udofin and group accounts is attested complete (A17).
  if not private.own_account_list_attested() then
    raise exception 'the list of accounts owned by Udofin and its group has not been attested complete' using errcode = '55000', hint = 'own_account_list_not_attested';
  end if;
  update tenancy.lender_settlement_accounts
  set registry_id = p_registry, status = 'verified', verified_by = v_uid, verified_at = now()
  where id = p_account;
  perform private.write_payments_audit(v_sa.lender_org_id,
    case when v_relink then 'payments.settlement_account.relinked' else 'payments.settlement_account.linked' end,
    'settlement_account', p_account::text, jsonb_build_object('registry_id', p_registry));
  return 'verified';
end
$$;
comment on function payments.link_settlement_account(uuid, uuid) is
  'Platform user with platform.accounts.registry.manage (aal2). The only function that makes a settlement account verified: it proves the registry entry is verified, owned by this lender, permitted for repayment_settlement, effective now, and has the same masked reference, and that the own-account list is attested complete (55000 own_account_list_not_attested). A linked account can move only from an entry under a RETIRED key version to that entry''s verified re-keyed successor (key rotation; payments.approve_fingerprint_key_version does this automatically, this is the fallback). The table trigger enforces the same proof for every other writer.';

-- ---------------------------------------------------------------------------------------------
-- 7. The own-account list: attest it complete, withdraw the attestation (A17)
-- ---------------------------------------------------------------------------------------------
create or replace function payments.attest_own_account_list(p_evidence_ref text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.verify']);
  v_key integer;
  v_verified integer;
  v_pending integer;
  v_last payments.own_account_attestations;
begin
  if p_evidence_ref is null or p_evidence_ref !~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#,()-]{2,199}$' then
    raise exception 'an evidence reference label is required (what the list was reconciled against: no file contents, no account details)'
      using errcode = '22023', hint = 'evidence_invalid';
  end if;
  if p_note is not null and length(p_note) > 1000 then
    raise exception 'a note must be at most 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select k.key_version into v_key from payments.fingerprint_key_versions k where k.status = 'active' for share;
  if v_key is null then
    raise exception 'no fingerprint key version is active' using errcode = '55000', hint = 'key_version_not_active';
  end if;
  -- Idempotent for the same attestor and evidence while it stands.
  select * into v_last from payments.own_account_attestations a where a.key_version = v_key order by a.occurred_at desc, a.id desc limit 1;
  if found and v_last.event_kind = 'attested' and v_last.actor_id = v_uid and v_last.evidence_ref = p_evidence_ref then
    return 'attested';
  end if;
  select count(*) filter (where r.verification_status = 'verified'), count(*) filter (where r.verification_status = 'unverified')
    into v_verified, v_pending
  from payments.account_registry r
  where r.key_version = v_key and r.owner_kind in ('udofin', 'group_company');
  -- Complete means: at least one verified Udofin or group account is loaded under the active key, and none is still waiting for verification.
  if v_pending > 0 or not exists (select 1 from payments.account_registry r where r.key_version = v_key and r.owner_kind = 'udofin' and r.verification_status = 'verified') then
    raise exception 'the own-account list is not loaded: at least one verified Udofin account and no pending Udofin or group account are required'
      using errcode = '55000', hint = 'own_account_list_incomplete';
  end if;
  insert into payments.own_account_attestations (event_kind, key_version, evidence_ref, reason, entries_counted, actor_id)
  values ('attested', v_key, p_evidence_ref, null, v_verified, v_uid);
  perform private.write_payments_audit(null, 'payments.own_account_list.attested', 'own_account_list', v_key::text,
    jsonb_build_object('key_version', v_key, 'entries_counted', v_verified));
  return 'attested';
end
$$;
comment on function payments.attest_own_account_list(text, text) is
  'Platform user with platform.accounts.registry.verify (aal2). Records, with an evidence reference label, that the list of accounts owned by Udofin and its group companies is loaded and COMPLETE under the ACTIVE fingerprint key version. Refused (55000 own_account_list_incomplete) unless at least one verified Udofin account exists under that key and no Udofin or group account is still unverified. No account detail is sent or stored. Until a current attestation exists a lender account cannot be verified or linked and payments or mandates cannot be switched on (hint own_account_list_not_attested). A key rotation needs a fresh attestation under the new version. Idempotent for the same attestor and evidence.';

create or replace function payments.withdraw_own_account_list_attestation(p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.manage', 'platform.accounts.registry.verify']);
  v_key integer;
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if length(trim(p_reason)) > 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select k.key_version into v_key from payments.fingerprint_key_versions k where k.status = 'active' for share;
  if v_key is null or not private.own_account_list_attested() then
    return 'withdrawn';
  end if;
  insert into payments.own_account_attestations (event_kind, key_version, reason, actor_id) values ('withdrawn', v_key, trim(p_reason), v_uid);
  perform private.write_payments_audit(null, 'payments.own_account_list.withdrawn', 'own_account_list', v_key::text, jsonb_build_object('key_version', v_key));
  return 'withdrawn';
end
$$;
comment on function payments.withdraw_own_account_list_attestation(text) is
  'Either registry permission (fail closed), aal2, one person, a reason of 10+ characters. Withdraws the current own-account-list attestation (for example because an Udofin or group account was found that is not on the list). Idempotent: nothing to withdraw is not an error.';

-- ---------------------------------------------------------------------------------------------
-- 8. Merchants (A19, M2, U52): a claim reveals nothing about other claims, is capped, can be withdrawn; one claim is verified
-- ---------------------------------------------------------------------------------------------
create or replace function payments.claim_merchant(p_lender uuid, p_provider text, p_merchant_ref text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.payments_require_lender(p_lender, 'payment.configure');
  v_existing payments.merchant_registry;
  v_id uuid;
begin
  if p_provider is null or not exists (select 1 from payments.provider_register r where r.provider = p_provider) then
    raise exception 'unknown provider' using errcode = '22023', hint = 'provider_invalid';
  end if;
  if p_merchant_ref is null or p_merchant_ref !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,99}$' then
    raise exception 'invalid merchant reference' using errcode = '22023', hint = 'merchant_ref_invalid';
  end if;
  -- Claims of one lender are counted and created one at a time.
  perform pg_advisory_xact_lock(hashtextextended('merchant_claim:' || p_lender::text, 0));
  -- THIS lender's own live claim of the id answers itself (idempotent). Nothing here reads another organisation's claim: a claim of an id
  -- that another lender or Udofin holds succeeds in exactly the same way as any other, so the answer reveals nothing about who holds an id.
  -- Whether a claim can ever be VERIFIED is a platform decision (payments.verify_merchant).
  select * into v_existing from payments.merchant_registry m
   where m.provider = p_provider and m.merchant_ref = p_merchant_ref and m.owner_kind = 'lender' and m.owner_org_id = p_lender and m.status = 'active';
  if found then
    return v_existing.id;
  end if;
  if (select count(*) from payments.merchant_registry m where m.owner_org_id = p_lender and m.status = 'active' and m.verification_status = 'unverified') >= 20 then
    raise exception 'too many unverified merchant claims: withdraw the ones you do not need' using errcode = '22023', hint = 'too_many_claims';
  end if;
  insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by)
  values (p_provider, p_merchant_ref, 'lender', p_lender, 'repayment', v_uid)
  returning id into v_id;
  perform private.write_payments_audit(p_lender, 'payments.merchant.claimed', 'merchant', v_id::text, jsonb_build_object('provider', p_provider));
  return v_id;
end
$$;
comment on function payments.claim_merchant(uuid, text, text) is
  'Lender user with payment.configure (aal2) claims a merchant id at a registered provider. A claim is only a CLAIM: it starts unverified, several lenders can claim the same id, and a claim of an id that someone else holds succeeds exactly like any other (no existence oracle). Idempotent for the same lender while its claim is live (a revoked or withdrawn claim is history: claiming again creates a new claim). At most 20 unverified live claims per lender (22023 too_many_claims). Only one live claim of an id can be verified (payments.verify_merchant).';

create or replace function payments.withdraw_merchant_claim(p_lender uuid, p_merchant uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.payments_require_lender(p_lender, 'payment.configure');
  v_m payments.merchant_registry;
begin
  select * into v_m from payments.merchant_registry m where m.id = p_merchant and m.owner_org_id = p_lender and m.owner_kind = 'lender' for update;
  if not found then
    raise exception 'merchant claim not found' using errcode = 'P0002';
  end if;
  if v_m.status = 'revoked' then
    return 'revoked';
  end if;
  if v_m.verification_status = 'verified' then
    raise exception 'a verified merchant is revoked by the platform, not withdrawn' using errcode = '55000', hint = 'already_verified';
  end if;
  update payments.merchant_registry
  set status = 'revoked', revoked_by = v_uid, revoked_at = now(), revoked_reason = 'withdrawn by the lender before verification'
  where id = p_merchant;
  perform private.write_payments_audit(p_lender, 'payments.merchant.withdrawn', 'merchant', p_merchant::text, jsonb_build_object('provider', v_m.provider));
  return 'revoked';
end
$$;
comment on function payments.withdraw_merchant_claim(uuid, uuid) is
  'Lender user with payment.configure (aal2) withdraws an UNVERIFIED claim of its own (the claim becomes revoked, as history). A verified claim cannot be withdrawn (55000 already_verified): the platform revokes it. Another lender''s claim reads as not found (P0002).';

-- Udofin's own fee-collection merchant. A verified lender claim of the same id blocks it (platform-only information); unverified claims
-- of the id stay unverifiable from then on.
create or replace function payments.register_udofin_fee_merchant(p_provider text, p_merchant_ref text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.payments.providers.manage']);
  v_existing payments.merchant_registry;
  v_id uuid;
begin
  if p_provider is null or not exists (select 1 from payments.provider_register r where r.provider = p_provider) then
    raise exception 'unknown provider' using errcode = '22023', hint = 'provider_invalid';
  end if;
  if p_merchant_ref is null or p_merchant_ref !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,99}$' then
    raise exception 'invalid merchant reference' using errcode = '22023', hint = 'merchant_ref_invalid';
  end if;
  select * into v_existing from payments.merchant_registry m
   where m.provider = p_provider and m.merchant_ref = p_merchant_ref and m.owner_kind = 'udofin_fees' and m.status = 'active';
  if found then
    return v_existing.id;
  end if;
  if exists (select 1 from payments.merchant_registry m where m.provider = p_provider and m.merchant_ref = p_merchant_ref
              and m.status = 'active' and m.verification_status = 'verified') then
    raise exception 'this merchant is already claimed' using errcode = '23505', hint = 'merchant_already_claimed';
  end if;
  begin
    insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by, verification_status,
                                            verification_evidence_ref, verified_by, verified_at)
    values (p_provider, p_merchant_ref, 'udofin_fees', null, 'fee_collection', v_uid, 'verified', 'platform-registered', v_uid, clock_timestamp())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'this merchant is already claimed' using errcode = '23505', hint = 'merchant_already_claimed';
  end;
  perform private.write_payments_audit(null, 'payments.merchant.registered_fees', 'merchant', v_id::text, jsonb_build_object('provider', p_provider));
  return v_id;
end
$$;

create or replace function payments.verify_merchant(p_merchant uuid, p_evidence_ref text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.payments.providers.manage']);
  v_m payments.merchant_registry;
begin
  if p_evidence_ref is null or p_evidence_ref !~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#,()-]{2,199}$' then
    raise exception 'an evidence reference label is required (3 to 200 plain characters)' using errcode = '22023', hint = 'evidence_ref_invalid';
  end if;
  select * into v_m from payments.merchant_registry m where m.id = p_merchant for update;
  if not found then
    raise exception 'merchant not found' using errcode = 'P0002';
  end if;
  if v_m.status <> 'active' then
    raise exception 'a revoked merchant cannot be verified' using errcode = '55000', hint = 'merchant_not_active';
  end if;
  if v_m.verification_status = 'verified' then
    if v_m.verified_by = v_uid and v_m.verification_evidence_ref = p_evidence_ref then
      return 'verified';
    end if;
    raise exception 'the merchant is already verified' using errcode = '55000', hint = 'already_verified';
  end if;
  if v_m.owner_kind <> 'lender' or v_m.claimed_by = v_uid then
    raise exception 'only a lender''s claim, by someone other than the claimant, is verified here' using errcode = '42501', hint = 'self_approval';
  end if;
  -- Only ONE live claim of an id can be verified: a competing claim is for the platform to settle on evidence (revoke the wrong one).
  begin
    update payments.merchant_registry set verification_status = 'verified', verified_by = v_uid, verified_at = clock_timestamp(),
           verification_evidence_ref = p_evidence_ref where id = p_merchant;
  exception when unique_violation then
    raise exception 'another claim of this merchant is already verified' using errcode = '55000', hint = 'merchant_already_claimed';
  end;
  perform private.write_payments_audit(v_m.owner_org_id, 'payments.merchant.verified', 'merchant', p_merchant::text, jsonb_build_object('provider', v_m.provider));
  return 'verified';
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 9. Settlement-account requests (A14, A15, M4) and withdrawal
-- ---------------------------------------------------------------------------------------------
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
  -- The canonical masked reference is six X and the last four digits (the registry's own form): nothing else can ever be linked.
  if v_label is null or length(v_label) not between 2 and 80 or v_bank is null or length(v_bank) not between 2 and 120
     or p_masked_ref is null or p_masked_ref !~ '^XXXXXX[0-9]{4}$'
     or private.acct_text_unsafe(v_label) or private.acct_text_unsafe(v_bank) then
    raise exception 'invalid settlement account request' using errcode = '22023', hint = 'settlement_account_invalid';
  end if;
  -- Requests of one lender are matched, counted and created one at a time (the unique index is the last line of defence).
  perform pg_advisory_xact_lock(hashtextextended('settlement_request:' || p_lender::text, 0));
  -- A revoked row (withdrawn by the lender or revoked with its registry entry) is history: it neither matches nor counts.
  select * into v_existing from tenancy.lender_settlement_accounts s
   where s.lender_org_id = p_lender and lower(s.bank_name) = lower(v_bank) and s.masked_account_ref = p_masked_ref and s.status <> 'revoked'
   order by s.created_at limit 1;
  if found then
    if v_existing.label = v_label then
      return v_existing.id;
    end if;
    raise exception 'a settlement account with this bank and masked reference already exists' using errcode = '23505', hint = 'settlement_account_exists';
  end if;
  if (select count(*) from tenancy.lender_settlement_accounts s where s.lender_org_id = p_lender and s.status <> 'revoked') >= 20 then
    raise exception 'too many settlement accounts' using errcode = '22023', hint = 'too_many_settlement_accounts';
  end if;
  begin
    insert into tenancy.lender_settlement_accounts (lender_org_id, label, bank_name, masked_account_ref)
    values (p_lender, v_label, v_bank, p_masked_ref)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'a settlement account with this bank and masked reference already exists' using errcode = '23505', hint = 'settlement_account_exists';
  end;
  perform private.write_payments_audit(p_lender, 'payments.settlement_account.requested', 'settlement_account', v_id::text, '{}'::jsonb);
  return v_id;
end
$$;
comment on function payments.request_settlement_account(uuid, text, text, text) is
  'A lender maker (payment.configure, second factor) asks for one of the lender''s own settlement accounts to be set up: label, bank and the canonical MASKED reference only (six X and the last four digits; anything else could never be linked). The label and the bank name are screened with private.acct_text_unsafe (nine or more digits once spaces and hyphens are removed, PAN or IFSC shapes, links, e-mail). The row starts unverified and becomes usable only when a platform user links it to a verified registry entry (payments.link_settlement_account). Idempotent on lender, bank and masked reference among LIVE rows (a revoked or withdrawn row is history and neither matches nor counts); at most 20 live accounts per lender; requests of one lender are serialised.';

create or replace function payments.withdraw_settlement_account(p_lender uuid, p_account uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.payments_require_lender(p_lender, 'payment.configure');
  v_sa tenancy.lender_settlement_accounts;
begin
  select * into v_sa from tenancy.lender_settlement_accounts s where s.id = p_account and s.lender_org_id = p_lender for update;
  if not found then
    raise exception 'settlement account not found' using errcode = 'P0002';
  end if;
  if v_sa.status = 'revoked' then
    return 'revoked';
  end if;
  if v_sa.registry_id is not null or v_sa.status <> 'unverified' then
    raise exception 'a settlement account that is linked to the registry is revoked by the platform, not withdrawn' using errcode = '55000', hint = 'already_linked';
  end if;
  update tenancy.lender_settlement_accounts set status = 'revoked' where id = p_account;
  perform private.write_payments_audit(p_lender, 'payments.settlement_account.withdrawn', 'settlement_account', p_account::text, '{}'::jsonb);
  return 'revoked';
end
$$;
comment on function payments.withdraw_settlement_account(uuid, uuid) is
  'A lender maker (payment.configure, second factor) withdraws a settlement account request that was never linked to the registry: the row becomes revoked (history) and no longer counts toward the cap or the duplicate match. A linked or verified account cannot be withdrawn (55000 already_linked). Another lender''s account reads as not found (P0002).';

-- ---------------------------------------------------------------------------------------------
-- 10. Payment configuration: sticky platform hold (A13, M0, U11, U49), one active per lender (M5), stable reason errors (M6)
-- ---------------------------------------------------------------------------------------------
alter table payments.lender_payment_config_events drop constraint lender_payment_config_events_event_kind_check;
alter table payments.lender_payment_config_events add constraint lender_payment_config_events_event_kind_check
  check (event_kind in ('drafted', 'submitted', 'approved', 'suspended', 'retired', 'hold_released'));

create or replace function private.protect_payment_config()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_moving text[] := array['status', 'submitted_by', 'submitted_at', 'approved_by', 'approved_at', 'status_changed_by', 'status_changed_at',
                           'status_reason', 'status_reasons', 'last_validated_at', 'last_validation_ok', 'updated_at',
                           'hold_kind', 'hold_set_by', 'hold_set_at'];
  v_result jsonb;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.approved_by is not null or new.submitted_by is not null or new.hold_kind is not null then
      raise exception 'a payment configuration starts as a draft' using errcode = '23514';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - v_moving) is distinct from (to_jsonb(old) - v_moving) then
    raise exception 'a payment configuration cannot be edited after drafting: draft a new one' using errcode = 'P0001';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if not (
    (old.status = 'draft' and new.status in ('pending_approval', 'retired'))
    or (old.status = 'pending_approval' and new.status in ('active', 'retired'))
    or (old.status = 'active' and new.status in ('suspended', 'retired'))
    or (old.status = 'suspended' and new.status in ('pending_approval', 'retired'))
  ) then
    raise exception 'payment configuration transition % -> % is not allowed', old.status, new.status using errcode = 'P0001';
  end if;
  -- A hold set by the platform or the system (the kill switch, a settlement to another account, a merchant mismatch, a failed nightly
  -- validation) is lifted only by payments.release_payment_config_hold. While it stands this configuration cannot be submitted or
  -- activated, and neither can any other configuration of the same lender: a new draft must not undo the hold (A13).
  if new.status in ('pending_approval', 'active') then
    if new.hold_kind is not null
       or exists (select 1 from payments.lender_payment_configs o
                   where o.lender_org_id = new.lender_org_id and o.id <> new.id and o.status = 'suspended' and o.hold_kind is not null) then
      raise exception 'a hold set by the platform or the system stands on a payment configuration of this lender' using errcode = '55000', hint = 'platform_hold';
    end if;
  end if;
  -- Activation is refused unless the collection target is valid RIGHT NOW, whoever asks (defence in depth).
  if new.status = 'active' then
    v_result := private.validate_collection_target_impl(new.id);
    if not (v_result ->> 'ok')::boolean then
      raise exception 'collection target invalid: %', v_result -> 'reasons' ->> 0 using errcode = '55000', hint = 'collection_target_invalid';
    end if;
  end if;
  return new;
end
$$;

create or replace function payments.submit_payment_config(p_config uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg payments.lender_payment_configs;
  v_uid uuid;
  v_result jsonb;
begin
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config for update;
  if not found or v_cfg.lender_org_id not in (select private.orgs_with_permission('payment.configure')) then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  v_uid := private.payments_require_lender(v_cfg.lender_org_id, 'payment.configure');
  if v_cfg.status = 'pending_approval' and v_cfg.submitted_by = v_uid then
    return 'pending_approval';
  end if;
  if v_cfg.status not in ('draft', 'suspended') then
    raise exception 'configuration is %, it cannot be submitted', v_cfg.status using errcode = '55000', hint = 'config_state_invalid';
  end if;
  -- A hold of the platform or the system is not the lender's to undo (A13): neither this configuration nor a new one is submitted while it stands.
  if v_cfg.hold_kind is not null
     or exists (select 1 from payments.lender_payment_configs o where o.lender_org_id = v_cfg.lender_org_id and o.id <> v_cfg.id
                 and o.status = 'suspended' and o.hold_kind is not null) then
    raise exception 'a hold set by the platform or the system stands on a payment configuration of this lender' using errcode = '55000', hint = 'platform_hold';
  end if;
  v_result := private.validate_collection_target_impl(p_config);
  if not (v_result ->> 'ok')::boolean then
    raise exception 'collection target invalid: %', v_result -> 'reasons' ->> 0 using errcode = '55000', hint = 'collection_target_invalid';
  end if;
  update payments.lender_payment_configs
  set status = 'pending_approval', submitted_by = v_uid, submitted_at = now(), approved_by = null, approved_at = null,
      status_changed_by = v_uid, status_changed_at = now(), status_reason = null, status_reasons = null,
      last_validated_at = now(), last_validation_ok = true
  where id = p_config;
  perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.submitted', 'payment_config', p_config::text, jsonb_build_object('from', v_cfg.status));
  return 'pending_approval';
end
$$;

create or replace function payments.decide_payment_config(p_config uuid, p_approve boolean, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg payments.lender_payment_configs;
  v_uid uuid;
  v_result jsonb;
begin
  if p_approve is null then
    raise exception 'approve must be true or false' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config for update;
  if not found or v_cfg.lender_org_id not in (select private.orgs_with_permission('payment.config.approve')) then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  v_uid := private.payments_require_lender(v_cfg.lender_org_id, 'payment.config.approve');
  if v_cfg.status = 'active' and v_cfg.approved_by = v_uid and p_approve then
    return 'active';
  end if;
  if v_cfg.status <> 'pending_approval' then
    raise exception 'configuration is %, not pending approval', v_cfg.status using errcode = '55000', hint = 'config_state_invalid';
  end if;
  if v_cfg.drafted_by = v_uid or v_cfg.submitted_by = v_uid then
    raise exception 'a configuration cannot be decided by the person who drafted or submitted it' using errcode = '42501', hint = 'self_approval';
  end if;
  if p_note is not null and length(p_note) > 1000 then
    raise exception 'a note must be at most 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if not p_approve then
    if p_note is null or length(trim(p_note)) < 10 then
      raise exception 'a rejection needs a reason' using errcode = '22023', hint = 'reason_required';
    end if;
    -- The reason is stored as "rejected: <note>" in a column of at most 1000 characters (M6).
    if length(trim(p_note)) + length('rejected: ') > 1000 then
      raise exception 'a rejection note must be at most 990 characters' using errcode = '22023', hint = 'reason_invalid';
    end if;
    update payments.lender_payment_configs
    set status = 'retired', status_changed_by = v_uid, status_changed_at = now(), status_reason = 'rejected: ' || trim(p_note)
    where id = p_config;
    perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.rejected', 'payment_config', p_config::text, '{}'::jsonb);
    return 'retired';
  end if;
  if not exists (
    select 1 from tenancy.memberships m
    join tenancy.membership_roles mr on mr.membership_id = m.id
    join tenancy.role_permissions rp on rp.role_id = mr.role_id
    where m.user_id = v_cfg.submitted_by and m.org_id = v_cfg.lender_org_id and m.status = 'active'
      and (m.valid_until is null or m.valid_until > now()) and rp.permission_key = 'payment.configure'
  ) then
    raise exception 'the submitter no longer holds the permission needed for this change' using errcode = '42501', hint = 'requester_not_entitled';
  end if;
  -- A hold of the platform or the system on a configuration of this lender is not the lender's to undo (A13).
  if exists (select 1 from payments.lender_payment_configs o where o.lender_org_id = v_cfg.lender_org_id and o.status = 'suspended' and o.hold_kind is not null) then
    raise exception 'a hold set by the platform or the system stands on a payment configuration of this lender' using errcode = '55000', hint = 'platform_hold';
  end if;
  v_result := private.validate_collection_target_impl(p_config);
  if not (v_result ->> 'ok')::boolean then
    raise exception 'collection target invalid: %', v_result -> 'reasons' ->> 0 using errcode = '55000', hint = 'collection_target_invalid';
  end if;
  -- One ACTIVE configuration per lender (M5): payments and mandates refuse a lender with two (config_ambiguous), so the unique index
  -- lender_payment_configs_one_active refuses the second one and this says why. The approver retires the old one first.
  begin
    update payments.lender_payment_configs
    set status = 'active', approved_by = v_uid, approved_at = now(), status_changed_by = v_uid, status_changed_at = now(),
        status_reason = p_note, status_reasons = null, last_validated_at = now(), last_validation_ok = true
    where id = p_config;
  exception when unique_violation then
    raise exception 'another payment configuration of this lender is active: retire it first' using errcode = '55000', hint = 'active_config_exists';
  end;
  perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.approved', 'payment_config', p_config::text,
    jsonb_build_object('provider_mode', v_cfg.provider_mode, 'drafted_by', v_cfg.drafted_by, 'submitted_by', v_cfg.submitted_by));
  return 'active';
end
$$;
comment on function payments.decide_payment_config(uuid, boolean, text) is
  'Lender user with payment.config.approve (aal2), a DIFFERENT person than the drafter and the submitter (42501 self_approval). Approval re-runs the collection-target validation (55000 collection_target_invalid with the first reason code in the message) and the submitter must still hold payment.configure. Refused (55000 platform_hold) while a hold set by the platform or the system stands on any configuration of the lender, and (55000 active_config_exists) while another configuration of the lender is active. Rejection retires the configuration and needs a note of 10 to 990 characters.';

create or replace function payments.withdraw_payment_config(p_config uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg payments.lender_payment_configs;
  v_uid uuid;
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  -- The reason is stored as "withdrawn: <reason>" in a column of at most 1000 characters (M6).
  if length(trim(p_reason)) + length('withdrawn: ') > 1000 then
    raise exception 'a reason must be 10 to 989 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config for update;
  if not found or v_cfg.lender_org_id not in (select private.orgs_with_permission('payment.configure')) then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  v_uid := private.payments_require_lender(v_cfg.lender_org_id, 'payment.configure');
  if v_cfg.status = 'retired' then
    return 'retired';
  end if;
  if v_cfg.status not in ('draft', 'pending_approval') then
    raise exception 'configuration is %, only a draft or pending configuration can be withdrawn', v_cfg.status using errcode = '55000', hint = 'config_state_invalid';
  end if;
  update payments.lender_payment_configs
  set status = 'retired', status_changed_by = v_uid, status_changed_at = now(), status_reason = 'withdrawn: ' || trim(p_reason)
  where id = p_config;
  perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.withdrawn', 'payment_config', p_config::text, '{}'::jsonb);
  return 'retired';
end
$$;

-- Platform kill switch: one person with platform.payments.providers.manage suspends an active configuration at once, and the suspension is a HOLD.
create or replace function payments.suspend_payment_config(p_config uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.payments.providers.manage']);
  v_cfg payments.lender_payment_configs;
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if length(trim(p_reason)) > 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config for update;
  if not found then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  if v_cfg.status = 'suspended' then
    -- Already suspended (for example by a cascade): the platform's call still puts its hold on it.
    if v_cfg.hold_kind is null then
      update payments.lender_payment_configs set hold_kind = 'platform', hold_set_by = v_uid, hold_set_at = now() where id = p_config;
      perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.hold_set', 'payment_config', p_config::text, jsonb_build_object('by', 'platform'));
    end if;
    return 'suspended';
  end if;
  if v_cfg.status <> 'active' then
    raise exception 'configuration is %, only an active configuration can be suspended', v_cfg.status using errcode = '55000', hint = 'config_state_invalid';
  end if;
  update payments.lender_payment_configs
  set status = 'suspended', status_changed_by = v_uid, status_changed_at = now(), status_reason = trim(p_reason), status_reasons = array['platform_suspension'],
      hold_kind = 'platform', hold_set_by = v_uid, hold_set_at = now()
  where id = p_config;
  perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.suspended', 'payment_config', p_config::text, jsonb_build_object('by', 'platform'));
  return 'suspended';
end
$$;
comment on function payments.suspend_payment_config(uuid, text) is
  'Platform kill switch: one user with platform.payments.providers.manage (aal2) suspends an active configuration at once. The suspension is a HOLD (hold_kind platform, who and when recorded): the lender can neither re-submit nor re-approve it, cannot retire it and cannot activate another configuration; only payments.release_payment_config_hold, by a DIFFERENT platform person, lifts it. A configuration that is already suspended without a hold receives the hold.';

-- Retire an active or suspended configuration for good: a platform user (providers.manage) or the lender's approver (not while a hold stands).
create or replace function payments.retire_payment_config(p_config uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg payments.lender_payment_configs;
  v_uid uuid := (select auth.uid());
  v_platform boolean := false;
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  -- The reason is stored as "retired: <reason>" in a column of at most 1000 characters (M6).
  if length(trim(p_reason)) + length('retired: ') > 1000 then
    raise exception 'a reason must be 10 to 991 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config for update;
  if not found then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  if v_uid is not null and private.has_platform_permission('platform.payments.providers.manage') then
    perform private.require_aal2();
    v_platform := true;
  elsif v_uid is not null and v_cfg.lender_org_id in (select private.orgs_with_permission('payment.config.approve')) then
    perform private.payments_require_lender(v_cfg.lender_org_id, 'payment.config.approve');
  else
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  if v_cfg.status = 'retired' then
    return 'retired';
  end if;
  if v_cfg.status not in ('active', 'suspended') then
    raise exception 'configuration is %, use withdraw for a draft or pending configuration', v_cfg.status using errcode = '55000', hint = 'config_state_invalid';
  end if;
  -- Retiring a held configuration would let the lender replace it: while a hold stands only the platform retires it (A13).
  if not v_platform and v_cfg.hold_kind is not null then
    raise exception 'a hold set by the platform or the system stands on this configuration' using errcode = '55000', hint = 'platform_hold';
  end if;
  update payments.lender_payment_configs
  set status = 'retired', status_changed_by = v_uid, status_changed_at = now(), status_reason = 'retired: ' || trim(p_reason)
  where id = p_config;
  perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.retired', 'payment_config', p_config::text, '{}'::jsonb);
  return 'retired';
end
$$;

-- System: put a configuration on hold for a stable reason code (for example `merchant_mismatch` when the provider's answer names a different
-- merchant than the configuration: spec 7.1 step 5, or `settlement_account_mismatch`). The suspension is a HOLD the lender cannot lift. Idempotent.
create or replace function payments.system_suspend_payment_config(p_config uuid, p_reason_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg payments.lender_payment_configs;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_reason_code is null or p_reason_code !~ '^[a-z][a-z0-9_]{2,60}$' then
    raise exception 'a reason code is required' using errcode = '22023', hint = 'reason_required';
  end if;
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config for update;
  if not found then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  if v_cfg.status = 'suspended' then
    if v_cfg.hold_kind is null then
      update payments.lender_payment_configs set hold_kind = 'system', hold_set_by = null, hold_set_at = now() where id = p_config;
      perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.hold_set', 'payment_config', p_config::text,
        jsonb_build_object('by', 'system', 'reason', p_reason_code));
    end if;
    return 'suspended';
  end if;
  if v_cfg.status <> 'active' then
    return v_cfg.status;
  end if;
  update payments.lender_payment_configs
  set status = 'suspended', status_changed_by = null, status_changed_at = now(), status_reason = 'system hold: ' || p_reason_code,
      status_reasons = array[p_reason_code], hold_kind = 'system', hold_set_by = null, hold_set_at = now()
  where id = p_config;
  perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.suspended', 'payment_config', p_config::text,
    jsonb_build_object('by', 'system', 'reason', p_reason_code));
  return 'suspended';
end
$$;

-- System, nightly: revalidate every active configuration (one lender, or all); any non-ok result suspends it, and the suspension is a hold.
create or replace function payments.revalidate_payment_configs(p_lender uuid default null)
returns table (config_id uuid, ok boolean, reasons text[], suspended boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg record;
  v_result jsonb;
  v_ok boolean;
  v_reasons text[];
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  for v_cfg in
    select c.id, c.lender_org_id from payments.lender_payment_configs c
    where c.status = 'active' and (p_lender is null or c.lender_org_id = p_lender)
    order by c.id
    for update
  loop
    v_result := private.validate_collection_target_impl(v_cfg.id);
    v_ok := (v_result ->> 'ok')::boolean;
    v_reasons := array(select jsonb_array_elements_text(v_result -> 'reasons'));
    if v_ok then
      update payments.lender_payment_configs set last_validated_at = now(), last_validation_ok = true where id = v_cfg.id;
    else
      update payments.lender_payment_configs
      set status = 'suspended', status_changed_by = null, status_changed_at = now(), status_reason = 'system hold: validation failed',
          status_reasons = v_reasons, last_validated_at = now(), last_validation_ok = false,
          hold_kind = 'system', hold_set_by = null, hold_set_at = now()
      where id = v_cfg.id;
      perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.suspended', 'payment_config', v_cfg.id::text,
        jsonb_build_object('by', 'system', 'reasons', to_jsonb(v_reasons)));
    end if;
    config_id := v_cfg.id; ok := v_ok; reasons := v_reasons; suspended := not v_ok;
    return next;
  end loop;
end
$$;

-- The only way a hold is lifted (A13). The configuration stays suspended: the lender then re-submits it (validated again) and a different
-- approver approves it, as for any suspended configuration.
create or replace function payments.release_payment_config_hold(p_config uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.payments.providers.manage']);
  v_cfg payments.lender_payment_configs;
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if length(trim(p_reason)) > 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config for update;
  if not found then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  if v_cfg.hold_kind is null then
    return v_cfg.status;
  end if;
  if v_cfg.status <> 'suspended' then
    raise exception 'configuration is %, only the hold of a suspended configuration can be lifted', v_cfg.status using errcode = '55000', hint = 'config_state_invalid';
  end if;
  -- A hold that a person set is lifted by somebody else; a system hold by any platform user holding the permission.
  if v_cfg.hold_kind = 'platform' and v_cfg.hold_set_by = v_uid then
    raise exception 'a platform hold cannot be lifted by the person who set it' using errcode = '42501', hint = 'self_approval';
  end if;
  update payments.lender_payment_configs set hold_kind = null, hold_set_by = null, hold_set_at = null where id = p_config;
  insert into payments.lender_payment_config_events (config_id, lender_org_id, event_kind, from_status, to_status, actor_kind, actor_id, note)
  values (p_config, v_cfg.lender_org_id, 'hold_released', 'suspended', 'suspended', 'platform', v_uid, trim(p_reason));
  perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.hold_released', 'payment_config', p_config::text,
    jsonb_build_object('hold_kind', v_cfg.hold_kind));
  return 'suspended';
end
$$;
comment on function payments.release_payment_config_hold(uuid, text) is
  'Platform user with platform.payments.providers.manage (aal2), a reason of 10 to 1000 characters. Lifts the hold of a suspended configuration (set by the kill switch, by a system suspension or by the nightly revalidation). A hold set by a platform person is lifted by a DIFFERENT person (42501 self_approval); a system hold by any platform user holding the permission. The configuration stays suspended: the lender must re-submit it and a different approver approve it again. Recorded in the configuration history (hold_released, with the reason) and in the audit trail.';

-- The prefix every secret name of a lender's configuration must start with, for the lender portal and the platform (U51).
create or replace function payments.secret_ref_prefix(p_lender uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or p_lender is null
     or not (p_lender in (select private.orgs_with_permission('payment.configure'))
             or p_lender in (select private.orgs_with_permission('payment.config.approve'))
             or p_lender in (select private.orgs_with_permission('payment.read'))
             or private.has_platform_permission('platform.payments.providers.manage')) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if not exists (select 1 from tenancy.organizations o where o.id = p_lender and o.kind = 'lender') then
    raise exception 'lender not found' using errcode = 'P0002';
  end if;
  return private.secret_ref_prefix(p_lender);
end
$$;
comment on function payments.secret_ref_prefix(uuid) is
  'The namespace prefix (L + twelve hexadecimal digits + underscore) that the secret_ref and the webhook_secret_ref of every payment configuration of the lender must start with. Readable by the lender''s payment users and by platform.payments.providers.manage. The platform provisions the secrets under these names in the secrets manager; resolvers must refuse any other name.';

-- ---------------------------------------------------------------------------------------------
-- 11. Activation prerequisites (A17, A42): the own-account list for payments and mandates. Every earlier check preserved (body of 915).
-- ---------------------------------------------------------------------------------------------
create or replace function private.feature_prerequisites_unmet(p_lender uuid, p_feature text)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reasons text[] := '{}';
  v_enableable boolean;
begin
  select c.enableable into v_enableable from servicing.feature_catalog c where c.feature = p_feature;
  if not found then
    v_reasons := v_reasons || 'feature_unknown'::text;
  elsif not v_enableable then
    v_reasons := v_reasons || 'feature_not_enableable'::text;
  end if;
  if not exists (select 1 from tenancy.organizations o where o.id = p_lender and o.kind = 'lender' and o.status = 'active') then
    v_reasons := v_reasons || 'lender_organisation_not_active'::text;
  end if;
  if not exists (select 1 from onboarding.lender_gates g where g.lender_org_id = p_lender and g.stage = 'activated') then
    v_reasons := v_reasons || 'onboarding_gate_not_activated'::text;
  end if;
  if not exists (
    select 1 from servicing.feature_change_requests r
    where r.lender_org_id = p_lender and r.feature = p_feature and r.status = 'pending' and r.enable and r.evidence <> '{}'::jsonb
  ) then
    v_reasons := v_reasons || 'evidence_missing'::text;
  end if;
  -- Phase 08a accounts and payment configuration. A mock or sandbox configuration can never satisfy this gate, whatever the
  -- session settings are (private.provider_mode_satisfies_production_gate).
  if p_feature in ('payments', 'mandates') then
    -- Migration 20261018000924 (A17): the list of accounts owned by Udofin and its group is attested complete, with evidence.
    if not private.own_account_list_attested() then
      v_reasons := v_reasons || 'own_account_list_not_attested'::text;
    end if;
    if not exists (
      select 1 from payments.lender_payment_configs c
      where c.lender_org_id = p_lender and c.status = 'active' and private.provider_mode_satisfies_production_gate(c.provider_mode)
    ) then
      v_reasons := v_reasons || 'payment_config_missing'::text;
      if exists (select 1 from payments.lender_payment_configs c where c.lender_org_id = p_lender and c.status = 'active') then
        v_reasons := v_reasons || 'payment_config_mock_or_sandbox_only'::text;
      end if;
    else
      if not exists (
        select 1
        from payments.lender_payment_configs c
        join tenancy.lender_settlement_accounts s on s.id = c.settlement_account_id and s.lender_org_id = c.lender_org_id
        join payments.account_registry r on r.id = s.registry_id
        where c.lender_org_id = p_lender and c.status = 'active' and private.provider_mode_satisfies_production_gate(c.provider_mode)
          and r.verification_status = 'verified'
      ) then
        v_reasons := v_reasons || 'registry_entry_not_verified'::text;
      end if;
      if not exists (
        select 1 from payments.lender_payment_configs c
        where c.lender_org_id = p_lender and c.status = 'active' and private.provider_mode_satisfies_production_gate(c.provider_mode)
          and (private.validate_collection_target_impl(c.id) ->> 'ok')::boolean
      ) then
        v_reasons := v_reasons || 'payment_config_validation_failed'::text;
      end if;
    end if;
  end if;
  -- Migration 20261018000914: servicing_sync needs an ACTIVE production-mode LMS connection (file import or manual entry; a mock or
  -- blocked connection never counts), statements_noc needs servicing_sync on, reminders need servicing_sync on, an approved policy and an
  -- approved English wording for each kind. An approved penal-charge text is NOT a prerequisite: without one, overdue reminders are
  -- suppressed and the lender is told (penal_text_missing).
  if p_feature = 'servicing_sync' then
    if not exists (
      select 1 from servicing.lms_connections c
      where c.lender_org_id = p_lender and c.status = 'active' and c.kind in ('file_import', 'manual') and private.provider_mode_satisfies_production_gate(c.provider_mode::text)
    ) then
      v_reasons := v_reasons || 'lms_connection_not_active'::text;
    end if;
  elsif p_feature = 'statements_noc' then
    if not private.feature_enabled(p_lender, 'servicing_sync') then
      v_reasons := v_reasons || 'servicing_sync_not_enabled'::text;
    end if;
  elsif p_feature = 'reminders' then
    if not private.feature_enabled(p_lender, 'servicing_sync') then
      v_reasons := v_reasons || 'servicing_sync_not_enabled'::text;
    end if;
    if not exists (select 1 from servicing.reminder_policies p where p.lender_org_id = p_lender and p.status = 'approved') then
      v_reasons := v_reasons || 'reminder_policy_missing'::text;
    end if;
    if (select count(distinct t.kind) from servicing.reminder_templates t
         where t.lender_org_id = p_lender and t.status = 'approved' and t.language = 'en') < 3 then
      v_reasons := v_reasons || 'reminder_templates_missing'::text;
    end if;
  end if;
  -- Migration 20261018000915: mandates need, in addition to a valid collection target (checked above, as for payments), a provider that offers mandates,
  -- rail limits in the configuration, the lender's own mandate settings and servicing_sync on (debits are planned from the lender's schedule).
  if p_feature = 'mandates' then
    if not exists (
      select 1 from payments.lender_payment_configs c join payments.provider_register r on r.provider = c.provider
      where c.lender_org_id = p_lender and c.status = 'active' and private.provider_mode_satisfies_production_gate(c.provider_mode)
        and r.status = 'approved' and r.kind in ('mandate', 'payment_and_mandate')
    ) then
      v_reasons := v_reasons || 'provider_not_mandate_capable'::text;
    end if;
    if not exists (
      select 1 from payments.lender_payment_configs c, unnest(array['enach_api', 'upi_autopay']) rail
      where c.lender_org_id = p_lender and c.status = 'active' and private.provider_mode_satisfies_production_gate(c.provider_mode)
        and (c.rail_limits -> rail ->> 'max_mandate_amount_minor') ~ '^[0-9]{1,15}$' and jsonb_typeof(c.rail_limits -> rail -> 'needs_afa_each_debit') = 'boolean'
    ) then
      v_reasons := v_reasons || 'mandate_rail_not_configured'::text;
    end if;
    if not exists (select 1 from payments.lender_mandate_policies p where p.lender_org_id = p_lender) then
      v_reasons := v_reasons || 'mandate_policy_missing'::text;
    end if;
    if not private.feature_enabled(p_lender, 'servicing_sync') then
      v_reasons := v_reasons || 'servicing_sync_not_enabled'::text;
    end if;
  end if;
  -- Later Phase 08a migrations add further feature-specific checks here: copy this body from the highest-numbered migration that defines it,
  -- append, and never remove or weaken a reason.
  return array(select distinct x from unnest(v_reasons) x order by x);
end
$$;
comment on function private.feature_prerequisites_unmet(uuid, text) is
  'Reasons a feature cannot be switched on for a lender; empty array = none. Generic checks: feature unknown or not enableable, lender organisation not active, onboarding gate not activated, evidence missing (the single pending enable request must carry evidence). payments (migration 20261018000910): payment_config_missing (no ACTIVE configuration in production mode), payment_config_mock_or_sandbox_only (only a mock or sandbox configuration is active: it can never satisfy the gate), registry_entry_not_verified (no active production configuration settles into a verified registry entry), payment_config_validation_failed (no active production configuration passes payments.validate_collection_target). EXTENDING: later migrations add feature-specific checks with CREATE OR REPLACE and MUST PRESERVE every earlier check (copy the body of the highest-numbered migration that defines this function and append; never remove or weaken a reason). A mock or sandbox provider record must never satisfy a check: use private.provider_mode_satisfies_production_gate. servicing_sync (migration 20261018000914): lms_connection_not_active (no ACTIVE file_import or manual connection in production mode). statements_noc: servicing_sync_not_enabled. reminders: servicing_sync_not_enabled, reminder_policy_missing (no approved policy), reminder_templates_missing (no approved English wording for each of pre_due, due_day and overdue). mandates (migration 20261018000915): the payments checks (payment_config_missing, payment_config_mock_or_sandbox_only, registry_entry_not_verified, payment_config_validation_failed) plus provider_not_mandate_capable, mandate_rail_not_configured (no rail with max_mandate_amount_minor and needs_afa_each_debit in the configuration), mandate_policy_missing, servicing_sync_not_enabled. own_account_list_not_attested (migration 20261018000924: for payments and mandates, the list of accounts owned by Udofin and its group has not been attested complete under the active key version, payments.attest_own_account_list).';
revoke all on function private.feature_prerequisites_unmet(uuid, text) from public;
grant execute on function private.feature_prerequisites_unmet(uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 12. servicing.set_lms_connection (A42): the connection row that servicing_sync itself needs
-- ---------------------------------------------------------------------------------------------
create or replace function servicing.set_lms_connection(
  p_lender uuid, p_kind text, p_status text, p_capabilities jsonb default '{}'::jsonb, p_staleness_minutes integer default 1440, p_secret_ref text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.servicing_require_user(p_lender, 'servicing.sync.manage');
  v_id uuid;
begin
  -- The switch needs an ACTIVE file_import or manual connection (private.feature_prerequisites_unmet), so that connection must be
  -- recordable BEFORE the switch is on (A42). That row sends nothing and stores no loan data: it is configuration. It is allowed while the switch
  -- is off only for those two kinds, and only for an active lender whose onboarding gate is activated. Everything else (a mock connection, a
  -- recorded REST connector, stage_import, commit_import, every servicing write) stays behind the switch.
  if not private.feature_enabled(p_lender, 'servicing_sync') then
    if coalesce(p_kind, '') not in ('file_import', 'manual')
       or not exists (select 1 from tenancy.organizations o join onboarding.lender_gates g on g.lender_org_id = o.id and g.stage = 'activated'
                       where o.id = p_lender and o.kind = 'lender' and o.status = 'active') then
      raise exception 'this feature is not enabled for the lender' using errcode = '55000', hint = 'feature_disabled';
    end if;
  end if;
  if p_kind is null or p_kind not in ('file_import', 'manual', 'mock', 'finbyx', 'generic_rest')
     or p_status is null or p_status not in ('draft', 'active', 'paused', 'blocked_unverified') then
    raise exception 'unknown connection kind or status' using errcode = '22023', hint = 'bad_request';
  end if;
  if p_kind in ('finbyx', 'generic_rest') and p_status <> 'blocked_unverified' then
    raise exception 'this connection kind has no specification and can only be recorded as blocked_unverified' using errcode = '55000', hint = 'connector_unverified';
  end if;
  if p_kind not in ('finbyx', 'generic_rest') and p_status = 'blocked_unverified' then
    raise exception 'only unverified connectors can be blocked_unverified' using errcode = '55000', hint = 'bad_status';
  end if;
  if not private.servicing_capabilities_ok(coalesce(p_capabilities, '{}'::jsonb)) then
    raise exception 'capabilities must be an object of known boolean flags' using errcode = '22023', hint = 'capabilities_invalid';
  end if;
  if p_staleness_minutes is null or p_staleness_minutes not between 5 and 43200 then
    raise exception 'the staleness threshold must be 5 to 43200 minutes' using errcode = '22023', hint = 'threshold_invalid';
  end if;
  if p_secret_ref is not null and (p_kind not in ('finbyx', 'generic_rest') or p_secret_ref !~ '^[A-Za-z][A-Za-z0-9_./-]{2,99}$') then
    raise exception 'a secret reference is a secret NAME and applies only to REST connectors' using errcode = '22023', hint = 'secret_ref_invalid';
  end if;
  insert into servicing.lms_connections (lender_org_id, kind, status, provider_mode, capabilities, staleness_threshold_minutes, secret_ref, created_by, updated_by)
  values (p_lender, p_kind, p_status, case when p_kind = 'mock' then 'mock' else 'production' end, coalesce(p_capabilities, '{}'::jsonb),
          p_staleness_minutes, p_secret_ref, v_uid, v_uid)
  on conflict (lender_org_id) do update
    set kind = excluded.kind, status = excluded.status, provider_mode = excluded.provider_mode, capabilities = excluded.capabilities,
        staleness_threshold_minutes = excluded.staleness_threshold_minutes, secret_ref = excluded.secret_ref, updated_by = excluded.updated_by
  returning id into v_id;
  perform private.servicing_audit(p_lender, 'servicing.connection.set', 'lms_connection', v_id::text,
    jsonb_build_object('kind', p_kind, 'status', p_status, 'staleness_threshold_minutes', p_staleness_minutes));
  return v_id;
end
$$;
comment on function servicing.set_lms_connection(uuid, text, text, jsonb, integer, text) is
  'Creates or updates the lender''s one LMS connection (servicing.sync.manage, aal2). file_import and manual may be recorded and made active BEFORE the servicing_sync switch is on (the switch needs an active connection), for an active lender whose onboarding gate is activated: that row sends nothing and stores no loan data. Every other kind (mock, finbyx, generic_rest) needs the switch on, as do stage_import, commit_import and every other servicing write. Mock only under the mock-provider guard; finbyx and generic_rest only as blocked_unverified.';

-- ---------------------------------------------------------------------------------------------
-- 13. Separation of duties under concurrency (U55): the checks read COMMITTED state, so two parallel grants could give one login both
--     halves of a pair. Both triggers now take a transaction-scoped advisory lock per login first (a second grant waits for the first to
--     commit and then sees it).
-- ---------------------------------------------------------------------------------------------
create or replace function private.enforce_payment_duty_segregation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pairs text[] := array['payment.configure', 'payment.config.approve', 'platform.accounts.registry.manage', 'platform.accounts.registry.verify',
                          'reminder.policy.manage', 'reminder.template.approve'];
  v_user uuid;
  v_new_keys text[];
  v_keys text[];
  v_partner text;
  i integer;
begin
  if tg_table_name = 'membership_roles' then
    select m.user_id into v_user from tenancy.memberships m where m.id = new.membership_id;
    perform pg_advisory_xact_lock(hashtextextended('sod:' || v_user::text, 0));
    select coalesce(array_agg(rp.permission_key), '{}') into v_new_keys
    from tenancy.role_permissions rp where rp.role_id = new.role_id;
    v_keys := private.user_permission_keys(v_user) || v_new_keys;
    for i in 1 .. cardinality(v_pairs) / 2 loop
      if v_pairs[2 * i - 1] = any (v_keys) and v_pairs[2 * i] = any (v_keys) then
        raise exception 'segregation of duties: one login cannot hold both % and %', v_pairs[2 * i - 1], v_pairs[2 * i]
          using errcode = '23514', hint = 'segregation_of_duties';
      end if;
    end loop;
  else
    -- Every login that holds the role is locked first (in a fixed order), then checked.
    for v_user in
      select distinct m.user_id
      from tenancy.membership_roles mr
      join tenancy.memberships m on m.id = mr.membership_id
      where mr.role_id = new.role_id and m.status <> 'revoked'
      order by m.user_id
    loop
      perform pg_advisory_xact_lock(hashtextextended('sod:' || v_user::text, 0));
    end loop;
    -- A permission added to a role: the role must not already carry the other half, and no login that already holds the
    -- role may end up with both halves through any of its other roles.
    for i in 1 .. cardinality(v_pairs) / 2 loop
      if new.permission_key in (v_pairs[2 * i - 1], v_pairs[2 * i]) then
        v_partner := case new.permission_key when v_pairs[2 * i - 1] then v_pairs[2 * i] else v_pairs[2 * i - 1] end;
        if exists (select 1 from tenancy.role_permissions rp where rp.role_id = new.role_id and rp.permission_key = v_partner) then
          raise exception 'segregation of duties: a role cannot carry both % and %', v_pairs[2 * i - 1], v_pairs[2 * i]
            using errcode = '23514', hint = 'segregation_of_duties';
        end if;
        for v_user in
          select distinct m.user_id
          from tenancy.membership_roles mr
          join tenancy.memberships m on m.id = mr.membership_id
          where mr.role_id = new.role_id and m.status <> 'revoked'
        loop
          if v_partner = any (private.user_permission_keys(v_user)) then
            raise exception 'segregation of duties: one login cannot hold both % and %', v_pairs[2 * i - 1], v_pairs[2 * i]
              using errcode = '23514', hint = 'segregation_of_duties';
          end if;
        end loop;
      end if;
    end loop;
  end if;
  return new;
end
$$;
create or replace function private.enforce_payment_duty_segregation_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The Phase 08a pairs and the Phase 02 pair (collections.work / dlg.manage), whose own trigger has the same gap.
  v_pairs text[] := array['payment.configure', 'payment.config.approve', 'platform.accounts.registry.manage', 'platform.accounts.registry.verify',
                          'reminder.policy.manage', 'reminder.template.approve', 'collections.work', 'dlg.manage'];
  v_keys text[];
  i integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('sod:' || new.user_id::text, 0));
  select coalesce(array_agg(distinct rp.permission_key), '{}') into v_keys
  from tenancy.memberships m
  join tenancy.membership_roles mr on mr.membership_id = m.id
  join tenancy.role_permissions rp on rp.role_id = mr.role_id
  where m.user_id = new.user_id and m.status <> 'revoked';
  for i in 1 .. cardinality(v_pairs) / 2 loop
    if v_pairs[2 * i - 1] = any (v_keys) and v_pairs[2 * i] = any (v_keys) then
      raise exception 'segregation of duties: one login cannot hold both % and %', v_pairs[2 * i - 1], v_pairs[2 * i]
        using errcode = '23514', hint = 'segregation_of_duties';
    end if;
  end loop;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 14. Tenancy change control can no longer be bypassed by a session setting (U53)
-- ---------------------------------------------------------------------------------------------
create or replace function private.require_change_context()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The setting alone proves nothing: any session can set a custom setting, and service_role can write these tables. The change is accepted
  -- only when it runs as the OWNER of the definer function that applies an approved change request (current_user is the function owner
  -- inside that function, and stays the session's own role everywhere else), or when a named human works as the database owner (break glass).
  if (current_setting('udofin.change_apply', true) = 'on' and current_user in ('postgres', 'supabase_admin'))
     or private.invoking_role() in ('postgres', 'supabase_admin') then
    return coalesce(new, old);
  end if;
  raise exception '% on %.% is only allowed through an approved change request', tg_op, tg_table_schema, tg_table_name
    using errcode = '42501', hint = 'Use private.request_change and an independent approver.';
end
$$;

create or replace function private.guard_status_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The setting alone proves nothing: any session can set a custom setting, and service_role can write these tables. The change is accepted
  -- only when it runs as the OWNER of the definer function that applies an approved change request (current_user is the function owner
  -- inside that function, and stays the session's own role everywhere else), or when a named human works as the database owner (break glass).
  if (current_setting('udofin.change_apply', true) = 'on' and current_user in ('postgres', 'supabase_admin'))
     or private.invoking_role() in ('postgres', 'supabase_admin') then
    return new;
  end if;
  raise exception 'changing status or ownership of %.% rows is only allowed through an approved change request',
    tg_table_schema, tg_table_name using errcode = '42501';
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 15. Grants for the new functions and refreshed comments
-- ---------------------------------------------------------------------------------------------
revoke all on function payments.attest_own_account_list(text, text) from public;
revoke all on function payments.withdraw_own_account_list_attestation(text) from public;
revoke all on function payments.withdraw_merchant_claim(uuid, uuid) from public;
revoke all on function payments.withdraw_settlement_account(uuid, uuid) from public;
revoke all on function payments.release_payment_config_hold(uuid, text) from public;
revoke all on function payments.secret_ref_prefix(uuid) from public;
grant execute on function payments.attest_own_account_list(text, text) to authenticated;
grant execute on function payments.withdraw_own_account_list_attestation(text) to authenticated;
grant execute on function payments.withdraw_merchant_claim(uuid, uuid) to authenticated;
grant execute on function payments.withdraw_settlement_account(uuid, uuid) to authenticated;
grant execute on function payments.release_payment_config_hold(uuid, text) to authenticated;
grant execute on function payments.secret_ref_prefix(uuid) to authenticated;

comment on function payments.register_account(text, integer, text, text, text, uuid, boolean, text, uuid, text, text[], date, date, text, jsonb, uuid) is
  'Platform user with platform.accounts.registry.manage (aal2). Registers the keyed-HMAC fingerprint computed by the BACKEND (the database never sees an account number) under an owner and permitted purposes. Refused (55000 account_format_unvalidated) unless the format rule is non-null, APPROVED, effective, for the same country and account type, and format_validated is true. The same (fingerprint, key_version) cannot be registered twice while an entry counts for it (23505 account_already_registered): an unverified or verified entry, or any entry that is not lender-owned, occupies the fingerprint; a rejected or revoked LENDER-owned entry releases it, so a mistaken registration can be corrected. This is BEST EFFORT, not one entry per real account: the fingerprint is a keyed hash of the bank code and the account number as typed, so the same account typed differently (leading zeros, a bank code changed by a merger) has another fingerprint; the verifier''s evidence check stays the stated control. Idempotent on (user, key). Only the ACTIVE fingerprint key version takes a registration (55000 key_version_not_allowed / key_version_not_active); p_other_fingerprints carries the same account''s fingerprint under every other live version, and an account already registered under another live key is refused (23505 account_registered_under_other_key) unless this call re-keys it (p_rekeys, rotation only; 22023 rekey_invalid under the active key). The entry stays unverified until a DIFFERENT person calls payments.verify_account.';
comment on function payments.approve_fingerprint_key_version(integer, text) is
  'Platform user with platform.accounts.registry.verify (aal2), a DIFFERENT login than the proposer (42501 segregation_of_duties). Refused (55000 rotation_incomplete) while any unverified or verified entry under the current active version has no re-keyed successor under the proposed one (and a successor of a verified entry must itself be verified). On success the proposed version becomes active, the previous one is retired and every verified settlement account moves to the verified successor of its registry entry (audit payments.settlement_account.relinked), all in the same transaction, so collections do not stop. The first version has nothing to cover. Until a version is active the registry accepts no entry and nothing classifies as permitted; after a rotation the own-account list needs a fresh attestation (payments.attest_own_account_list).';
comment on function payments.verify_account(uuid, text, text) is
  'Platform user with platform.accounts.registry.verify (aal2), a DIFFERENT person than the registrant (42501 self_approval); the registrant must still hold platform.accounts.registry.manage. Needs an evidence reference label. A LENDER-owned entry is verified only while the own-account list is attested complete (55000 own_account_list_not_attested); entries of Udofin, a group company or anyone else build that list and need no attestation. unverified -> verified. Idempotent for the same verifier and evidence.';
comment on function payments.verify_merchant(uuid, text) is
  'Platform user with platform.payments.providers.manage (aal2). Confirms, against evidence (a reference label, no file bytes), that the merchant identifier a lender CLAIMED really belongs to that lender at that provider. unverified -> verified, once. Only ONE live claim of a (provider, merchant_ref) can be verified: a competing claim is refused (55000 merchant_already_claimed) until the verified one is revoked. A payment configuration is valid only while its merchant is verified and active (reason merchant_not_verified). Udofin''s own fee merchant is registered verified by the platform and can never take repayments.';
comment on function payments.register_udofin_fee_merchant(text, text) is
  'Platform user with platform.payments.providers.manage (aal2). Udofin''s own fee-collection merchant (owner_kind udofin_fees, purpose fee_collection), registered verified. Refused (23505 merchant_already_claimed) when a lender''s claim of the same id is already verified; unverified claims of the id stay but can never be verified. A configuration can never reference it (composite key to its own lender).';
comment on function payments.revoke_merchant(uuid, text) is
  'platform.payments.providers.manage. The claim becomes revoked for good (history); ACTIVE configurations using it are suspended in the same transaction (merchant_not_active). Revoking the VERIFIED claim of an id releases the id: another claim of it can then be verified.';
comment on function payments.draft_payment_config(uuid, text, text, uuid, uuid, text, text, text, jsonb, text, text, text, text) is
  'Lender user with payment.configure (aal2). The secret_ref and the webhook_secret_ref are NAMES of secrets that must start with the lender''s own namespace (payments.secret_ref_prefix: L + twelve hexadecimal digits + underscore) and be different from each other (22023 secret_ref_invalid); the namespace is stored on the configuration (secret_namespace) for the resolvers to check. Rail limits and the source note are screened for personal data. Idempotent on (user, key).';
comment on function payments.submit_payment_config(uuid) is
  'Lender user with payment.configure (aal2). draft or suspended -> pending_approval after the collection-target validation (55000 collection_target_invalid). Refused (55000 platform_hold) while a hold set by the platform or the system stands on this configuration or on any other configuration of the lender.';
comment on function payments.retire_payment_config(uuid, text) is
  'Active or suspended -> retired, for good: a platform user (providers.manage, aal2) or the lender''s approver (payment.config.approve, aal2). While a hold stands only the platform retires the configuration (55000 platform_hold for the lender). The reason is stored as "retired: <reason>" and must fit 1000 characters in all (22023 reason_invalid).';
comment on function payments.system_suspend_payment_config(uuid, text) is
  'System only. Idempotent HOLD of an ACTIVE configuration for a stable reason code (for example merchant_mismatch or settlement_account_mismatch): the configuration is suspended with hold_kind system, and only payments.release_payment_config_hold by a platform user lifts it. A suspended configuration without a hold receives the hold; a configuration that is not active is returned as it is.';
comment on function payments.revalidate_payment_configs(uuid) is
  'System only (nightly, or after a registry change). Revalidates every ACTIVE configuration and suspends any whose validation is not ok; the suspension is a system HOLD (lifted only by payments.release_payment_config_hold). Returns config_id, ok, reasons, suspended.';
