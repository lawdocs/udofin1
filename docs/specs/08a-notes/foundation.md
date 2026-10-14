# Phase 08a notes: stream FOUNDATION (database)

Migration `supabase/migrations/20261018000908_p08a_foundation.sql` (forward-only). pgTAP: `supabase/tests/015_p08a_foundation.test.sql` (204 assertions). Snapshot edits: `supabase/tests/006_authorization_matrix.test.sql` (three tables, twelve permissions, eighteen role grants). `001_structure` and `013_remediation_db` needed no edit (no new unindexed foreign key; the generic checks already cover the new tables and functions).

Read the code, not only this note. Error convention: `SQLSTATE|hint`. 42501 not authorised, P0002 not found, 22023 bad input, 55000 rule/state, 23505 duplicate, 23514 segregation of duties.

## 1. Activation switches (fail closed)

### Tables (schema `servicing`; all: RLS enabled and forced, `comment on table` naming the owner module, `no_truncate` trigger)

| Table                               | Purpose                                                                                                                                                                                                                  | authenticated                                                                                                           | service_role | Write path                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------ |
| `servicing.feature_catalog`         | `feature text pk`, `enableable boolean`, `introduced_in` (`phase_08a`/`08b`/`08c`), `description`, `locked_reason` (required when not enableable). Seeded with 7 rows                                                    | select, only for users with an active organisation membership (borrowers and users with no organisation see nothing)    | select       | migration role only (trigger `catalog_migration_only`, 42501)      |
| `servicing.lender_features`         | `(lender_org_id, feature)` pk, `enabled bool default false`, `evidence jsonb`, `enabled_by/at`, `disabled_by/at`, `last_change_request_id`, `updated_at`. **No rows seeded**                                             | select where the user holds `loan.read` or `payment.read` in that lender, or `platform.features.manage` on the platform | select       | only `servicing.decide_feature_change` / `kill_feature` (definers) |
| `servicing.feature_change_requests` | history of every request: `enable`, `mode` (`two_person`/`emergency`), `status` (`pending`/`applied`/`rejected`/`cancelled`/`expired`), `evidence`, `reason`, requester, decider, idempotency key, `expires_at` (7 days) | select own requests, or all with `platform.features.manage`                                                             | select       | only the four `servicing.*_feature_*` functions                    |

Features (`feature_catalog`): `servicing_sync`, `payments`, `mandates`, `reminders`, `statements_noc` are enableable; `collections` and `dlg` are **not**. `service_role` has SELECT only on all three tables (the default `ALL` was revoked): the system can never switch a feature on or forge a request. No unindexed foreign keys (013 list unchanged).

### Rules enforced by the database

- `collections` and `dlg` can never be enabled: trigger `guard` on `lender_features` (`private.guard_lender_feature`) refuses `enabled = true` when the catalogue says not enableable (55000, hint `feature_not_enableable`). It fires for every role including the table owner and the migration role; it consults the catalogue, so **the only bypass is a later owner-approved migration that changes `servicing.feature_catalog`** (only `postgres`/`supabase_admin` can write the catalogue; every other role is refused with 42501 `catalog_is_migration_only`, even if a grant is added by mistake). `private.feature_enabled` also returns false for a stored switch whose catalogue row is not enableable. This is written into the table comments.
- Any change of `enabled` must be backed by a request already `applied` **in the same transaction** (`applied_at = transaction_timestamp()`) for the same lender and feature, and turning ON additionally needs `mode = 'two_person'` with `decided_by` set and different from `requested_by` (55000, hint `two_person_required`). A table-level check (`no_self_approval`) also forbids `decided_by = requested_by`.
- Inserting a switch row for a non-lender organisation is refused (55000, `not_a_lender`).
- Switch rows cannot be deleted (`forbid_mutation`, P0001); requests cannot be edited after filing, deleted, or changed once final (P0001).
- Evidence is a flat object of at most 20 short string references (keys `^[a-z][a-z0-9_]{1,40}$`, values 1 to 200 characters), refused if a value looks like a secret, a phone number, a PAN or Aadhaar pattern, an e-mail address or a run of 11 or more digits (`private.feature_evidence_ok`). This is defence in depth, not a personal-data scanner.

### Functions

| Function                                                                                                                                                               | Who may call                                                   | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `servicing.request_feature_change(p_lender uuid, p_feature text, p_enable boolean, p_evidence jsonb, p_idempotency_key text, p_reason text default null) returns uuid` | `authenticated` with platform `platform.features.manage`, aal2 | Idempotent on (user, key); same key with different content: 23505 `idempotency_conflict`. Enabling needs non-empty evidence (55000 `evidence_missing`), an enableable feature (55000 `feature_not_enableable`) and an empty `private.feature_prerequisites_unmet` (55000 `prerequisites_unmet`, message lists the generic reasons). Disabling needs `p_reason` of 10+ characters (22023 `reason_required`). Already in that state: 55000 `no_change`. Second pending request for the same switch: 23505 `pending_request_exists`. Writes audit `servicing.feature_change.requested`.                                      |
| `servicing.decide_feature_change(p_request uuid, p_approve boolean, p_note text default null) returns text`                                                            | same permission, **a different user** than the requester       | Self-decision: 42501 `self_approval`. Not pending: 55000 `request_not_pending`. Past `expires_at`: marks `expired` and returns `'expired'`. Rejection needs a note of 10+ characters (22023 `reason_required`) and returns `'rejected'`. Approval re-checks that the requester still holds the permission (42501 `requester_not_entitled`) and, for enabling, the prerequisites (55000 `prerequisites_unmet`, request stays pending), then marks the request `applied`, upserts `lender_features` and writes the audit event (`servicing.feature_change.enabled` or `.disabled`) in one transaction; returns `'applied'`. |
| `servicing.cancel_feature_change(p_request uuid) returns void`                                                                                                         | the requester only                                             | Pending to `cancelled`; otherwise P0002.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `servicing.kill_feature(p_lender uuid, p_feature text, p_reason text, p_idempotency_key text) returns uuid`                                                            | one user with `platform.features.manage`, aal2                 | **Emergency kill switch**: turns the switch OFF at once (works on any catalogue feature), records an `emergency` request (reason of 10+ characters required, 22023 `reason_required`), cancels any pending request for the same switch so it cannot undo the kill, writes audit `servicing.feature_change.emergency_disabled`. Idempotent. It cannot turn anything on; re-enabling always needs a fresh two-person request.                                                                                                                                                                                               |
| `private.feature_enabled(p_lender uuid, p_feature text) returns boolean`                                                                                               | `service_role` only (definers calling it run as owner)         | True only if the switch is on, the catalogue says enableable, `tenancy.organizations.status = 'active'` with `kind = 'lender'`, and `onboarding.lender_gates.stage = 'activated'`. Everything else (no row, unknown feature, unknown lender) is false.                                                                                                                                                                                                                                                                                                                                                                    |
| `private.require_feature(p_lender uuid, p_feature text) returns void`                                                                                                  | `service_role` only                                            | Raises 55000, hint `feature_disabled`, message `this feature is not enabled for the lender`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `private.feature_prerequisites_unmet(p_lender uuid, p_feature text) returns text[]`                                                                                    | `service_role` only                                            | Sorted stable identifiers, empty array = none: `feature_unknown`, `feature_not_enableable`, `lender_organisation_not_active`, `onboarding_gate_not_activated`, `evidence_missing` (the single **pending enable request** for the pair must carry evidence). Mock-provider and feature-specific checks are added by later migrations.                                                                                                                                                                                                                                                                                      |
| `private.user_holds_platform_permission(p_user uuid, p_permission text) returns boolean`                                                                               | `service_role` only                                            | Whether any user (not the caller) holds a platform permission now.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

`feature_enabled`, `require_feature` and `feature_prerequisites_unmet` are deliberately not executable by `authenticated` (a lender could otherwise probe other lenders' state). Later definer functions (for example `payments.request_payment`) call them as the function owner, which needs no grant. Lender staff read their own switch rows directly from `servicing.lender_features` under RLS.

### Extending `private.feature_prerequisites_unmet` (gotcha for later migrations)

The function is replaced wholesale with `create or replace`. A later migration must **copy the body from the highest-numbered migration that defines it and append its check**; never drop or weaken an earlier reason. If two streams extend it in different migration files, the later file must contain both extensions. Use `private.provider_mode_satisfies_production_gate(mode)` for every provider-evidence check so a mock or sandbox record can never satisfy a production gate. The function comment repeats this.

### How to enable a feature in tests

The system role and the API roles cannot write switches. In pgTAP (one transaction) and in an integration test's single transaction, the owner can insert an `applied` request and then the switch, in the same transaction:

```sql
-- requester <> decider; lender organisation status 'active'; onboarding.lender_gates.stage 'activated'
insert into servicing.feature_change_requests (id, lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
values (:req, :lender, 'payments', true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-1"}', :user_a, 'test-key-0000000001', :user_b, now(), now());
insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
values (:lender, 'payments', true, '{"contract_ref":"SAMPLE-1"}', :user_b, now(), :req);
```

The two rows must be in one transaction (the guard compares `applied_at` with `transaction_timestamp()`), which also means a request cannot be reused later to flip a switch. The real path is `request_feature_change` by one platform user with `platform.features.manage` (aal2) and `decide_feature_change` by another.

## 2. Mock and sandbox provider guard

| Object                                                                         | Behaviour                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `private.provider_mode` (domain over text)                                     | `check (value in ('mock','sandbox','production'))`. Use as a column type; refusal is 23514. `private.is_provider_mode(text) returns boolean` is the same test for check constraints.                                                                                 |
| `private.mock_providers_allowed()`                                             | True only when `current_setting('udofin.allow_mock_providers', true) = 'on'` (exact value). Same pattern as `udofin.allow_mock_connectors`.                                                                                                                          |
| `private.sandbox_providers_allowed()`                                          | True only when `udofin.allow_sandbox_providers = 'on'`. The database cannot know the environment, so sandbox is off unless the session says so.                                                                                                                      |
| `private.assert_provider_mode_allowed(p_mode text) returns void`               | 22023 `provider_mode_invalid` for null or unknown; 42501 `mock_provider_blocked`; 42501 `sandbox_provider_blocked`; `production` always passes. Executable by `authenticated` and `service_role`.                                                                    |
| `private.guard_provider_mode()` (row trigger function)                         | `create trigger guard before insert or update on <table> for each row execute function private.guard_provider_mode('provider_mode');` The argument names the column (default `provider_mode`). Asserts on every insert and update (no exemption for unchanged rows). |
| `private.provider_mode_satisfies_production_gate(p_mode text) returns boolean` | True only for `production` (false for null). **A mock or sandbox provider can never satisfy a production activation gate**, whatever the session settings are. Activation checks added to `feature_prerequisites_unmet` must use this.                               |

Residual risk: any database session can set a custom setting, so this is one of three levels (configuration, `assertProviderAllowed`, this guard). The login options of the production API and system roles must leave both settings unset; tests set them per session (`PGOPTIONS='-c udofin.allow_mock_providers=on'`, or `select set_config(..., 'on', false)`).

## 3. Permissions, roles, separation of duties

New permissions (all `platform_grantable = false`; platform-side ones `platform_only = true`):

| Side     | Keys                                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lender   | `payment.configure`, `payment.config.approve`, `payment.reconcile`, `servicing.sync.manage`, `servicing.manual_entry`, `servicing.document.issue`, `reminder.policy.manage`, `reminder.template.approve` |
| platform | `platform.payments.providers.manage`, `platform.accounts.registry.manage`, `platform.accounts.registry.verify`, `platform.features.manage`                                                               |

New system roles (organisation id null): lender `servicing_operator` (`loan.read`, `servicing.sync.manage`, `servicing.manual_entry`, `servicing.document.issue`), `payments_admin` (`payment.read`, `payment.configure`), `payments_approver` (`payment.read`, `payment.config.approve`), `reconciler` (`payment.read`, `payment.reconcile`), `communications_admin` (`loan.read`, `reminder.policy.manage`), `communications_approver` (`loan.read`, `reminder.template.approve`); platform `platform_payments_admin` (`platform.payments.providers.manage`, `platform.accounts.registry.manage`), `platform_account_verifier` (`platform.accounts.registry.verify`), `platform_features_admin` (`platform.features.manage`). Existing roles (`lender_admin`, `platform_admin`, ...) gained none of the maker-checker permissions. Grants to roles are made by migration; assigning a role to a person goes through the existing change-request mechanism.

Separation of duties (trigger function `private.enforce_payment_duty_segregation`, triggers `membership_roles_segregation_payments` and `role_permissions_segregation_payments`, same style as collections.work vs dlg.manage): one login (across all memberships) cannot hold both `payment.configure` and `payment.config.approve`, nor `platform.accounts.registry.manage` and `platform.accounts.registry.verify`; one role cannot carry both. 23514, hint `segregation_of_duties`. Not segregated (owner question): `reminder.policy.manage` vs `reminder.template.approve`; downstream tables should enforce "approver is not the drafter" per row.

## 4. Money text parser

`private.parse_money_minor(p_text text) returns bigint`: immutable, parallel safe, **not** declared STRICT (null raises). Executable by `authenticated` and `service_role`. Grammar: `^(0|[1-9][0-9]{0,15})([.][0-9]{1,2})?$` (ASCII digits only), result at most `100000000000000` paise; every failure raises 22023, hint `money_invalid`, message `invalid money amount` (the input is never echoed). Integer arithmetic only.

Shared vectors. The TypeScript parser (`packages/adapters/src/money.ts`) must accept every `valid` input with the given paise (decimal string) and reject every `invalid` input (JSON `null` means a null/undefined argument). They are verified against the database function. Regex hint for TypeScript: `/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/` without the `m` flag and without `\d`; compare as `bigint`. pgTAP uses the same 24 valid and 50 invalid vectors.

```json
{
  "valid": [
    { "input": "0", "minor": "0" },
    { "input": "0.0", "minor": "0" },
    { "input": "0.00", "minor": "0" },
    { "input": "0.5", "minor": "50" },
    { "input": "0.05", "minor": "5" },
    { "input": "0.50", "minor": "50" },
    { "input": "0.99", "minor": "99" },
    { "input": "1", "minor": "100" },
    { "input": "1.01", "minor": "101" },
    { "input": "9", "minor": "900" },
    { "input": "10", "minor": "1000" },
    { "input": "20.10", "minor": "2010" },
    { "input": "100.1", "minor": "10010" },
    { "input": "1250", "minor": "125000" },
    { "input": "1250.5", "minor": "125050" },
    { "input": "1250.50", "minor": "125050" },
    { "input": "1250.05", "minor": "125005" },
    { "input": "1250.00", "minor": "125000" },
    { "input": "10000000", "minor": "1000000000" },
    { "input": "123456789012", "minor": "12345678901200" },
    { "input": "999999999999.99", "minor": "99999999999999" },
    { "input": "1000000000000", "minor": "100000000000000" },
    { "input": "1000000000000.0", "minor": "100000000000000" },
    { "input": "1000000000000.00", "minor": "100000000000000" }
  ],
  "invalid": [
    null,
    "",
    " ",
    " 1250",
    "1250 ",
    "1 250",
    "1250\n",
    "\t1250",
    "1250\r",
    " 1250",
    "+1250",
    "-1250",
    "-0",
    "+0",
    "1e3",
    "1E3",
    "1e-2",
    "0x10",
    "1,250",
    "1,250.50",
    "1_250",
    "1250.",
    ".5",
    ".",
    "1250.505",
    "1250.500",
    "1250.001",
    "00",
    "01",
    "007",
    "00.5",
    "01.50",
    "1250,50",
    "1.2.3",
    "abc",
    "12a",
    "Infinity",
    "NaN",
    "0.5.",
    "1000000000000.01",
    "1000000000001",
    "9999999999999999",
    "99999999999999999",
    "١٢٣",
    "१२३",
    "１２３",
    "12１",
    "₹1250",
    "Rs 1250",
    "1250/-"
  ]
}
```

## 5. Gotchas for downstream streams

- New tables in these schemas get `service_role` ALL by default privilege: REVOKE what the table must not allow (this migration shows the pattern: `revoke all ... from service_role; grant select ...`), add a row to the 006 matrix, and index every foreign key (the 013 list is exact).
- `private.provider_mode` is a domain in `private`; a column typed with it needs the usual `USAGE` on schema `private` (already granted to `authenticated` and `service_role`).
- A temp or test table using `private.guard_provider_mode()` needs the session setting set before the insert; remember `set_config(..., true)` is transaction-local in pgTAP.
- `private.feature_prerequisites_unmet` reads the pending request: asking it "what blocks payments for lender X?" with no pending request always includes `evidence_missing`.
- Nothing here creates a payment, mandate, account or servicing table, and no switch is seeded.

## 6. Not done here (owner decisions and later work)

- Whether `reminder.policy.manage` and `reminder.template.approve` should also be segregated per login (only the pairs named in the task were).
- Kill switch audit: written to `audit.events` (actor type `platform`); an alert on `servicing.feature_change.emergency_disabled` is an observability item, not built.
- Operations-portal screens and API routes for requests and decisions belong to the API stream: they call the four `servicing.*` functions under the signed-in user's JWT (aal2 required).
