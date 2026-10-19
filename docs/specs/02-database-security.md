# Phase 02 specification: database and security foundation

**Status:** draft for owner approval (13 October 2026). Nothing in this phase has been implemented; questions that need your decision are in section 9, each with a recommendation.
**Branch (when approved):** `phase-02/db-security`, one pull request, small commits.
**Depends on:** Phase 01 baseline (approved provisionally on 13 October 2026).

## 1. Objective in plain English

Phase 01 made the database refuse the wrong things (one lender seeing another's data, history being rewritten, payments marked paid with no proof). Phase 02 makes the **whole path from a user's phone or a staff member's browser to those database rules real and tested**:

1. A request arrives with a login token. The API **verifies the token properly**, decides who the person is from the database (never from what the token claims), and runs every query **as that person**, so the database's row-level security applies to the API too.
2. **Staff must use a second factor** (an authenticator app) before the API serves them anything.
3. The few actions that change who may do what (onboarding a lender, adding a staff member, granting a role, publishing consent wording) happen **only through a two-person approval** and leave an audit trail.
4. The API connects with **minimum database privileges** and there is a test that fails if code that is not meant to use the all-powerful role tries to.
5. A **permission matrix test** states, for every role, what is allowed and what is denied, and fails if anyone changes a permission by accident.

Nothing in this phase shows a borrower a screen or moves any money.

## 2. What already exists (so we do not redo it)

Migration `0600_hardening.sql` already closed most of the "schema review" work: five-way actor model (borrower / lender / platform / system / none), separate logins for borrowers and staff, platform-versus-lender separation, TRUNCATE protection, audit scoping, offer/payment/consent integrity, and RLS-supporting indexes. Its independent review is in [`../security/review-2026-10-10.md`](../security/review-2026-10-10.md). This phase builds the **runtime** that uses those rules and closes the review's still-open items.

## 3. Decisions applied

| Decision                                                   | Applied how                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-01 baseline approved "for the moment"                    | Spec builds on it; changes are allowed later, recorded as ADRs                                                                                                                                                                 |
| D-02 entity = **Infrabyx Consultancy OPC Private Limited** | Recorded in organisation reference data as the platform organisation's legal name, with CIN to be supplied (nothing is guessed)                                                                                                |
| D-10/D-11 Udofin gives a 5% DLG and acts as recovery agent | Architecture in [`../architecture/collections-and-dlg.md`](../architecture/collections-and-dlg.md); implementation Phase 08. Phase 02 adds the **permission keys and the segregation rule** so later phases cannot bypass them |
| D-05 compliance owner appointed                            | Named contact will be added to the Phase 04 regulatory sign-off table; five RBI texts filed under `docs/regulatory/sources/`                                                                                                   |
| D-06/D-07 India-based hosting; paid Supabase plan          | See questions Q1–Q3. The API stays container-based and host-agnostic; Supabase network restrictions are part of this phase                                                                                                     |

## 4. Scope

### W1. Close the review's open items and prepare for later phases (migration `0700`)

- **Actor attribution in audit:** add the `partner` and `platform` actor values the model already distinguishes; system jobs write audit rows through a dedicated function, not by direct insert.
- **Offer display log** (needed by the comparison screen's "log what each borrower was shown", ADR 0022): `lending.offer_displays`, append-only, one row per borrower per display with the ranking-rule version. Table only; no screen.
- **Matching rule versions:** `lending.matching_rule_versions` (documented mechanism, effective period, publicly disclosed metric), required by para 7(2) and 7(4) of Chapter III.
- **Lender settlement accounts:** `tenancy.lender_settlement_accounts` (the account a payment settles into), referenced by `payments.payment_intents` instead of free text. Account numbers are stored **encrypted with the lender's key** (envelope encryption helper arrives with Phase 06; until then only a masked reference and a verification status are stored).
- **Event type pattern:** allow a registered third-party system source (`in.ext.<code>…`) so a non-Finbyx LMS can send events (open question from the API/contracts review).
- **`kfs_document_id` foreign key:** deferred to Phase 07 when documents exist; recorded here so it is not forgotten.
- **Permission catalogue additions:** `collections.work`, `collections.manage`, `collections.read`, `collections.policy`, `dlg.read`, `dlg.manage`, `dlg.invoke` (see collections architecture, section 4.3), with a **database rule that one login cannot hold both `collections.work` and `dlg.manage`** (para-6 conflict-of-interest control).
- **Borrower name and address** (para 14(1) lists name, address and contact details as the LSP's allowed minimum): **not added here**; Phase 05 adds them as lender-scoped fields.

### W2. Controlled administration with two-person approval (migration `0710`)

Today nothing lets any user create a lender, add a staff member or publish consent wording; those writes were left to "the API under the system role" with no approval. This phase adds:

- `tenancy.change_requests`: type (`organization.create`, `membership.invite`, `membership.suspend`, `role.grant`, `role.revoke`, `consent_notice.publish`), payload, requested by, approved by, status, timestamps. **Requester and approver must be different people, each holding the relevant permission**, enforced by a database check.
- `private.apply_change_request(id)`: a database function, callable only by the system role, that re-validates the approval, makes the change and writes the audit event **in one transaction**. No other path may change memberships, roles or organisations.
- Organisation onboarding cannot reach `active` for a lender without a regulator registration number (already enforced) **and** an approved change request.

### W3. API database layer

- **Two database logins**, neither a superuser, neither able to bypass row-level security:
  - `udofin_api`: may `SET ROLE authenticated` only. Used for every user-initiated request.
  - `udofin_system`: may `SET ROLE service_role` only. Used by workers and the narrow admin module (W2).
    Roles are created by migration **without passwords**; passwords are set out-of-band and stored in the secrets manager.
- **`withUserContext(claims, fn)`:** opens a transaction, `SET LOCAL ROLE authenticated`, sets the verified claims for that transaction only, hands `fn` a typed query handle, and **destroys the handle when the transaction ends**. A handle used afterwards throws.
- **Typed queries with Kysely**, types generated from the migrations; no raw string SQL built from request data (lint rule).
- **Fail closed:** if the claims are missing or invalid, the helper refuses to run (it never falls back to the system role).
- Connection settings already added in the hardening commit (statement timeout, idle-in-transaction timeout, TLS enforcement when deployed) stay.

### W4. Token verification, actor resolution and staff MFA

- Verify tokens with **`jose` against the Supabase JWKS** (asymmetric signing keys): issuer, audience, expiry, algorithm allow-list. Keys are cached with a short refresh and a hard failure on unknown key ids.
- **No custom claims.** The API asks the database "who is this user and what may they do" on each request (`GET /v1/me`), using `private.current_actor()` and the permission functions. This removes the planned custom access-token hook: fewer moving parts and no stale permissions when a membership is suspended (see Q4).
- **Staff must present an `aal2` session** (second factor completed). A staff token at `aal1` receives `401` with a problem code `mfa_required`; borrowers are not required to use TOTP (they sign in with phone OTP in Phase 05).
- **Staff accounts exist only by invitation** (W2); Supabase email self-sign-up is already disabled.
- First real endpoint: **`GET /v1/me`** returning the actor type, active memberships and permission keys. It is the vertical slice that proves token → role → RLS end to end.

### W5. `service_role` boundary

- Lint rule and import boundary: only `src/system/*` and `src/workers/*` may import the system pool; everything else may import only the user-context helper.
- Startup guard: the API refuses to start if the configured user-pool login is a member of `service_role`, a superuser, or has `BYPASSRLS` (queried at boot).
- A test fails if a module outside the allowed folders imports the system pool.

### W6. Authorisation matrix tests

- Generated from the live catalogue (`tenancy.permissions`, roles, role_permissions) and every domain table. For each system role and each table the test states the expected `select / insert / update / delete` result as **allowed, denied or own-rows-only**, and fails if the actual result differs or if a new table/role is added without an expected row.
- The same matrix is exercised through the API for the endpoints that exist (`/v1/me` and the change-request endpoints).

### W7. Supabase configuration in version control

- `supabase/config.toml` for **hosted-like** settings (separate from the local-development defaults): minimum password length and leaked-password protection, TOTP enrolment, refresh-token rotation, JWT expiry, session time-box for staff, phone OTP rate limits, signup flags. The file documents which settings the CLI cannot push (network restrictions, SMTP, SMS provider) and links to a short runbook in `docs/operations/supabase-setup.md`.
- **Network restrictions** (inbound allow-list for the database) are configured in the dashboard on the paid plan; the runbook records exactly which addresses are allowed (the API host's static address and named admin addresses). See Q2 on what "fixed IP" does and does not give you.

### W8. Documentation and records

- ADR 0023 (collections and DLG) rewritten against the primary text; new ADR 0025 (two-person change control); ADR 0004 and 0005 updated for the two logins and `withUserContext`.
- Controls matrix: rows for DLG, recovery agent, disbursement, repayment, grievance and data, upgraded to **confirmed (primary text)** with paragraph references, from the Chapter III extract.
- Module status, roadmap Phase 02 and open-decisions updated with your answers.

## 5. Out of scope (stays in later phases)

Phone OTP for borrowers and the SMS provider (05); lender onboarding screens (04); portal login screens (03); envelope encryption (06); documents and signatures (07); the DLG ledger, collections and payments **implementation** (08); any hosted deployment of the API.

## 6. Data and API changes

| Change                                                                            | Type                          | Notes                                                              |
| --------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `0700` new tables and columns (section W1)                                        | Forward-only migration        | No data exists; expand-only                                        |
| `0710` change requests and `apply_change_request`                                 | Forward-only migration        | No existing writes depend on the old gap                           |
| Roles `udofin_api`, `udofin_system`                                               | Migration without passwords   | Passwords out-of-band                                              |
| `GET /v1/me`                                                                      | New endpoint                  | `Authorization: Bearer <Supabase JWT>`; problem+json on all errors |
| `POST/GET /v1/admin/change-requests`, `POST …/{id}/approve`, `POST …/{id}/reject` | New endpoints (staff, `aal2`) | Idempotency-Key required on POST                                   |

**Permissions used:** existing `platform.organizations.manage`, `org.members.manage`, `platform.consent_notices.manage`, plus the additions in W1. A request's type decides which permission the requester and approver need.

## 7. Failure and security considerations

| Risk                                                                                                                 | Handling                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A bug lets code run SQL as the wrong role                                                                            | Two logins with exactly one assumable role each; boot guard; lint boundary; matrix tests                                                                                                                                                            |
| A session on the `authenticated` role changes its own claims setting (platform behaviour, open item from the review) | Only the API can open such sessions (network restrictions, API-only login); all SQL is typed and generated; handle destroyed after the transaction; a test proves the handle cannot be reused. **Residual risk stays recorded** in the threat model |
| Token verification gaps (algorithm confusion, wrong audience, stale keys)                                            | Algorithm allow-list, audience and issuer pinned, key refresh with hard failure, negative tests for each                                                                                                                                            |
| Staff with a stolen password                                                                                         | `aal2` required; suspended membership loses access on the next request (no cached permissions)                                                                                                                                                      |
| Admin changes by one person                                                                                          | Two-person change requests; DB check; audit event in the same transaction                                                                                                                                                                           |
| Lock or data-loss risk in the new migrations                                                                         | All migrations are additive on empty tables (checklist in `docs/data/migrations.md`); no hosted database is touched in this phase                                                                                                                   |
| Mobile/API/DB version drift                                                                                          | No client change in this phase; `/v1/me` is new, so nothing existing breaks                                                                                                                                                                         |

## 8. Acceptance criteria (each is a test)

1. The pgTAP suite passes on the Supabase stack (Postgres 17) in CI and locally.
2. **Matrix test:** every system role × domain table has an explicit expected result for select/insert/update/delete and all pass; adding a table, role or permission without a matrix entry fails the build.
3. **Token tests:** wrong audience, wrong issuer, expired, `alg:none`, a token signed by an unknown key, and a key-rotation case are all rejected with `401`; a valid token returns `GET /v1/me`.
4. **Isolation through the API:** a lender A token cannot read lender B's application; a borrower token returns only that borrower's rows; a suspended membership receives `403` on the next request.
5. **MFA:** a staff token at `aal1` gets `401 mfa_required` from every staff route; at `aal2` it succeeds; a borrower token is unaffected.
6. **Boot guard:** the API refuses to start when its user login is a superuser, has `BYPASSRLS`, or can assume `service_role` (three separate tests).
7. **Import boundary:** a module outside `src/system` and `src/workers` importing the system pool fails lint **and** a unit test.
8. **Handle lifetime:** using the query handle after the transaction ends throws; a missing or invalid claims object never reaches the database.
9. **Change requests:** requester ≠ approver (database-enforced), each must hold the relevant permission, approval applies the change and writes the audit event atomically, and a rejected or stale request changes nothing; org onboarding to `active` is impossible without an approved request.
10. **Segregation:** one login cannot hold both `collections.work` and `dlg.manage`; a collections role cannot read DLG tables (matrix).
11. All new tables: RLS enabled and forced, no `anon` grants, composite tenant keys, tests for cross-tenant negatives.
12. `pnpm lint`, `pnpm typecheck`, `pnpm test`, the database suite and the secret scan are green; the diff contains no secrets, no real data and no unrelated changes.

## 9. Questions for you (each with my recommendation)

| #   | Question                                                                                                                                                                                                                                                                                                                                                                 | Why it matters                                                                                                                                                                                                                      | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | The Supabase project **`Udofin-app`** already contains a prototype `profiles` table (6 rows, including a `pin` column) and a signup function created outside migrations. Should the Phase 02 migrations be applied to it?                                                                                                                                                | If applied as is, the prototype table stays exposed through Supabase's REST API with its own rules, and a `pin` field of unknown meaning sits beside the new schema.                                                                | **Do not apply to it.** Create a fresh project (Mumbai region) for **staging with synthetic data**, and decide the future of `Udofin-app` once you have confirmed what the 6 rows and the `pin` column are. If the rows are test accounts, we can archive and reset it to become production later.                                                                                                                  |
| Q2  | Decision 5 says a paid Supabase plan gives you "a fixed or white IP". In my understanding it gives something slightly different: **Network Restrictions**, an allow-list of the addresses that may connect **to** your database. A lender or KYC provider asking for your **outgoing** IP needs a fixed address on **your API server**, not Supabase. Which do you need? | It decides the hosting set-up and cost.                                                                                                                                                                                             | You need **both**: (a) the API host with a **static outbound address** (to give lenders and providers), and (b) Supabase restricted to that address plus a few named admin addresses. Please confirm that is what lenders asked for. I will verify the exact Supabase features and plan on its pricing page before relying on this (my information may be out of date).                                             |
| Q3  | Hosting: "AWS, or any India-based server to save cost".                                                                                                                                                                                                                                                                                                                  | The RBI outsourcing text contains conditions for cloud and IT outsourcing that any provider must meet (details in `docs/regulatory/primary/02-outsourcing-directions-2025.md` when the agent completes); lenders will diligence it. | Keep the API **in a container with no provider-specific code** (already true). For MVP, a **single small virtual server in an Indian region with a reserved static address** is enough if the provider can show security certification, audit rights and exit terms. Final choice deferred to Phase 03 after the outsourcing extract is finished; AWS Mumbai remains the default because lenders already accept it. |
| Q4  | Skip the **custom access-token hook** (claims carried in the token) from the roadmap?                                                                                                                                                                                                                                                                                    | The hook is the usual way to carry roles in tokens, but a token can be valid for up to an hour after a staff member is suspended.                                                                                                   | **Yes, skip it.** Resolve permissions from the database on every request. We can add cached claims later if load requires it.                                                                                                                                                                                                                                                                                       |
| Q5  | Two-person approval for administration needs **two named people** at launch (for example you and the compliance owner). Who are the two initial approvers?                                                                                                                                                                                                               | Without two humans no lender can be onboarded.                                                                                                                                                                                      | You (product owner) and the compliance owner; confirm names and corporate email addresses. Staff accounts will use authenticator-app MFA.                                                                                                                                                                                                                                                                           |
| Q6  | Which Supabase plan: Pro or Team?                                                                                                                                                                                                                                                                                                                                        | The MFA step I need is enforced in the API, so **Pro** is enough. Team adds the compliance report and single sign-on.                                                                                                               | **Pro now**; revisit Team when a lender asks for the SOC 2 report or single sign-on.                                                                                                                                                                                                                                                                                                                                |

## 10. Proposed commits

1. `feat(db): audit actors, offer display log, matching rules, settlement accounts, new permissions`
2. `feat(db): two-person change requests and apply function`
3. `feat(db): API and system login roles, boot-time role checks`
4. `feat(api): token verification, actor resolution and GET /v1/me`
5. `feat(api): withUserContext, typed queries (Kysely), import boundary`
6. `feat(api): staff MFA enforcement and change-request endpoints`
7. `test: authorisation matrix (pgTAP and API)`
8. `docs: ADRs 0023 and 0025, controls matrix, module status, Supabase runbook`

Each commit runs the full checks first; the PR description carries the acceptance checklist with results.
