# ADR-0005: Tenancy — shared schema with row level security as defence in depth

- **Status:** Accepted (baseline, pending owner approval)
- **Date:** 2026-10-10
- **Related:** ADR-0004, ADR-0006, ADR-0009, ADR-0013

## Context

- Udofin serves several partner lenders (tenants). One borrower request may be routed to several lenders, creating one application per lender. Lender A must never see lender B's applications, offers, loans, payments or consents.
- Lenders' outsourcing rules require the LSP to keep each lender's data confidential and isolated, and to return or delete it on exit (research: likely, `docs/research/2026-10-10/privacy-security-outsourcing.md` OUT-4).
- Udofin operations staff need limited, audited access across lenders to resolve exceptions.
- A single application bug (a missing `WHERE lender_org_id = ...`) must not leak another lender's data.

## Decision

1. **Shared database, shared tables.** Every tenant-owned row carries `lender_org_id` referencing `tenancy.organizations`.
2. **Composite foreign keys.** Tenant-owned child rows reference parents through `(id, lender_org_id)`, so a child row cannot point at another lender's parent. Examples: `loan_product_versions → loan_products`, `applications → loan_product_versions`, `application_events / offers → applications`, `loan_accounts → applications`, `schedule_snapshots → loan_accounts`, `schedule_installments → schedule_snapshots`, `payment_intents → loan_accounts`.
3. **Row level security everywhere.** RLS is enabled on every domain table and **forced** on tables that hold borrower or tenant data (forced RLS applies even to the table owner). Policies are permission-based and use security-definer helpers in the `private` schema: `private.my_org_ids()`, `private.orgs_with_permission(p)`, `private.has_platform_permission(p)`, `private.my_borrower_id()`. The helpers return sets so policies use `lender_org_id in (select ...)`, evaluated once per statement.
4. **API-only access.** Domain schemas are not exposed via PostgREST; `anon` has no schema usage or grants. Users get column-level grants only: tenant keys, borrower ids and amounts cannot be rewritten by users; `authenticated` has no DELETE on any domain table.
5. **RLS is the second layer.** The API authorises each request itself, then runs the query as `authenticated` with the caller's claims (ADR-0004), so a missed check in code is still blocked by the database.
6. **Platform staff** reach lender data only through permissions marked `platform_grantable`, held by a role in the single platform organisation (ADR-0006). Every such access is to be audited by the API (ADR-0013).
7. **Borrowers** see only their own rows (`borrower_id = private.my_borrower_id()`), across all lenders they applied to.
8. **Membership state is live:** suspended, revoked or expired (`valid_until`) memberships, and organisations not in `onboarding`/`active`, grant nothing, from the next statement.
9. Per-lender cryptographic isolation of sensitive artefacts (KYC, bureau, documents) is decided in ADR-0009 (planned).

## Alternatives considered

| Option                                                   | Why rejected                                                                                                                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema per lender                                        | Migrations multiply per tenant; cross-lender borrower views (one request, many lenders) become unions across schemas; RLS still needed for borrowers.                                               |
| Database per lender                                      | Strongest isolation, but a borrower's multi-lender request spans databases; operations and cost multiply; one Supabase project per lender. Kept as an option if a lender contractually requires it. |
| Filtering in application code only                       | One missed filter leaks data; no independent control to show auditors.                                                                                                                              |
| RLS as the only layer (clients query PostgREST directly) | No second layer; business rules and audit would sit in policies. See ADR-0004.                                                                                                                      |

## Consequences

**Positive**

- Isolation holds even if API code forgets a filter; this is demonstrable with tests.
- One schema and one migration path for all lenders.
- A borrower can compare offers from several lenders without cross-database joins.

**Negative**

- Policies add complexity and some query cost; helpers must stay `stable`, set-returning and indexed.
- All lenders share one database: capacity problems or an incident affect everyone.
- Tenant exit means exporting and deleting by `lender_org_id` across many tables (crypto-shredding is planned in ADR-0009).

**Risks and known gaps (baseline)**

- `payments.provider_events.payment_intent_id` references `payment_intents(id)` only, not `(id, lender_org_id)`, and `lender_org_id` is nullable there; a system bug could attribute an event to the wrong lender.
- `lending.applications.borrower_id` is not constrained to equal the borrower of `loan_request_id`; `servicing.loan_accounts.borrower_id` is not tied to the application's borrower. Only system code writes these rows today.
- Reference tables (`tenancy.permissions`, `tenancy.roles`, `tenancy.role_permissions`, `consent.notices`, `lending.product_categories`, `lending.application_transitions`) have RLS enabled but not forced.
- A platform role holding a `platform_grantable` permission sees that data for **all** organisations, including suspended or offboarded lenders (`private.orgs_with_permission`).
- `service_role` bypasses RLS entirely (ADR-0004).

## Compliance and security notes

- Supports lender requirements to isolate each lender's data (research: likely). Evidence: the pgTAP isolation suite, migration review, and (planned) API access audit logs.
- Primary-source verification gate applies (README).

## Verification

- `supabase/tests/002_tenant_isolation.test.sql` (34 assertions), including: lender A's officer sees only lender A's applications, offers, lifecycle events, loan accounts, schedules and consents; cannot update lender B's application; cannot issue an offer under lender B's id (`42501`); composite keys make an offer on another lender's application impossible (`23503`); lender staff cannot list borrowers or loan requests; borrowers see only their own records; the ops agent reads across lenders but cannot change anything; staff with no role see nothing; a suspended membership loses access immediately.
- `supabase/tests/001_structure.test.sql`: RLS enabled and forced, no `anon`/`public` grants, no DELETE for `authenticated`, definer helpers pinned and not executable by `anon`.

## Revisit triggers

- A lender contractually requires physical separation (own database or project).
- Policy cost shows up in query plans at production volume.
- Any of the known gaps above is closed by a migration (update this ADR's gap list through a superseding ADR if the model changes).

## Amendment (13 October 2026, Phase 02)

- The API connects as `udofin_api`, which can only `SET ROLE authenticated`; workers and the change-request module connect as `udofin_system`, which can only `SET ROLE service_role`. Neither is a superuser, owner or `BYPASSRLS`. The API refuses to start if the user login could skip row-level security or assume `service_role`.
- Every user request runs through `withUserContext`: one transaction, `SET LOCAL ROLE authenticated`, verified claims set for that transaction only; the query handle stops working when the transaction ends, so it cannot be reused. Claims carry identity and assurance level only: **permissions are resolved from the database on every request**, so a suspended member loses access on the next request.
- Only `src/system` and `src/workers` may import the system pool (lint rule and unit test).
- Organisations, memberships and role grants change only through two-person change requests (ADR-0025).
