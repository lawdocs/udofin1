# ADR-0032: Tenant ownership and the authorization rule

- **Status:** Proposed (written 14 October 2026 from the architecture verification; the code already follows it, but the owner has not approved it as a written rule)
- **Date:** 2026-10-14
- **Related:** ADR-0004, ADR-0005, ADR-0006, ADR-0011, ADR-0025, ADR-0030, ADR-0033; `docs/architecture/phase-02-architecture-verification.md` (register item G and decision D-Q1)

## Context

Tenant isolation is the property lenders care about most, and it is enforced by several mechanisms spread over ADR-0005 (row level security),
ADR-0004 and its amendment (the per-request transaction), ADR-0006 (permissions), ADR-0011 as amended (workers) and ADR-0030 (the callback receiver).
The architecture verification read the code and found that it follows one consistent rule, but that the rule is written down nowhere as a whole.
Without a single statement, a new module, a worker handler or a lender integration could drift from it unnoticed. The questions it must answer are:
where does a row's tenant come from, who decides what a caller may do, which database role does each kind of code run as, and how may a background job learn which tenant it is acting for.

Actors: platform staff (Udofin operations and administration), lender organisation members, borrowers (cross-lender by design, seen by lenders only through
per-lender consented sharing), and external parties (providers and lender systems) that have no identity in the system and reach it only through signed callbacks.

## Decision

1. **The tenant is a column on the row.** Every tenant-owned table carries the owning lender organisation (`lender_org_id`, or `org_id`/`tenant_org_id` where the row is about
   an organisation itself, as listed in `docs/data/ownership.md`) referencing `tenancy.organizations`. Child rows reference their parent through a composite key that includes the
   tenant, so a child cannot point at another tenant's parent. A row's tenant is never inferred from a request field, a path, a header or a token claim.
2. **Membership and permissions are resolved only in the database.** Tokens prove identity and assurance level only (`sub`, `aal`, session id). Which organisations a caller belongs to and what
   they may do is read from `tenancy.*` at query time through the helpers in the `private` schema (`private.my_org_ids()`, `private.orgs_with_permission(p)`, `private.has_platform_permission(p)`,
   `private.my_borrower_id()`, `private.current_actor()`). A suspended member loses access on the next statement. No role, organisation or permission claim in a token is trusted.
3. **Every request path runs as `authenticated` with the caller's claims.** One transaction per request: `SET LOCAL ROLE authenticated` and the verified claims set for that transaction only
   (`services/api/src/db/user-context.ts`). The query handle stops working when the transaction ends. The API's login (`udofin_api`) can assume only `authenticated`, and the API refuses to
   start if that login could bypass row level security or assume `service_role`.
4. **Authorisation is enforced twice.** The route checks that the caller may attempt the operation (audience, assurance level, permission), and the database enforces it again in
   the policy or function that touches the data. Neither layer may be skipped because the other exists.
5. **A tenant id supplied by a client is a selector, never authority.** When a request names an organisation, the database function checks that the caller holds the needed permission for
   that organisation. A value that fails the check is refused; it is not corrected, defaulted or trusted.
6. **The system role is confined.** `service_role` (reached through `udofin_system`, which can only `SET ROLE service_role`) is used only by code under `services/api/src/system` and
   `services/api/src/workers`. Its pool is not importable elsewhere (lint rule and boundary test), and the HTTP server entry point does not import those folders. The public API process never holds
   the system login. The lender callback receiver is a separate small process precisely because it needs that login.
7. **Background jobs and callbacks take the tenant from persisted rows, never from the message alone.** An outbox event carries references (ids); the handler loads the row it refers to and
   derives the tenant from that row inside a database function. A lender callback names a lender and a correlation reference; the signature is verified over the raw bytes first, and the database
   then matches the message to an application and lender recorded earlier. A tenant, lender or application claimed only in a payload is not enough to act on.
8. **No privileged shortcut for convenience.** Administrative changes to organisations, memberships and roles go through two-person change requests (ADR-0025), not through ad hoc system-role writes
   from request handlers.
9. **Every new tenant-owned table** has the tenant column, row level security enabled and forced, explicit grants, an entry in the authorisation matrix test, and pgTAP tests that include cross-tenant
   negative cases (`CLAUDE.md` rule 2). A table without a tenant that is nevertheless readable by tenants (a reference table) is listed with its reason.

Out of scope: per-lender cryptographic isolation of documents (ADR-0009, ADR-0010 and `docs/operations/document-store-production-spec.md`), and physical separation per lender, which stays an option if a lender requires it (ADR-0005).

## Implementation state

Written from the code as it stood on 14 October 2026; each point is checkable.

- Points 1, 2, 4 and 9: composite tenant keys and forced row level security on all tenant tables; the helpers above; the authorisation matrix `supabase/tests/006_authorization_matrix.test.sql` and
  cross-tenant tests in `002`, `008` to `012`. Gaps recorded in the audit: the `documents` schema being absent from the grant snapshot test (F-07) and the definer/search-path check covering only the `private` schema (F-08) were closed in commits `ae79a85` and `4fc97d3`. Still open by design: six deliberately unforced shared reference tables.
- Point 3: `services/api/src/db/user-context.ts`, `services/api/src/db/login-posture.ts`, `services/api/test/user-context.test.ts`, `services/api/test/login-posture.test.ts`.
- Point 6: root `eslint.config.mjs` restricts imports of the system pool; `services/api/test/boundary.test.ts` checks the same and that the server entry point does not import `src/system` or `src/workers`.
- Point 7: for example the routing jobs hold only an application id, and consent, state and tenant are re-checked inside the database when the job runs (`services/api/src/workers/routing-handlers.ts`,
  ADR-0030); the callback receiver is `services/api/src/workers/lender-callbacks.ts`.
- Point 8: `supabase/migrations/20261013000710_change_requests.sql`.

Not enforced by a test today: that **every** worker handler obeys point 7. It holds for the handlers that exist (change requests, routing, documents), by review. A new handler must be reviewed against this ADR.

## Alternatives considered

| Option                                                    | Why rejected                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Put the active organisation or role in the token          | Claims outlive a membership change; the database must stay the single place that knows who may do what (ADR-0004 amendment).                          |
| Let the API alone decide, with the database as storage    | One missed check leaks data. The database check is the independent second layer (ADR-0005).                                                           |
| Trust the tenant named in a message or callback payload   | A forged or mistaken payload would act in the wrong tenant. The persisted row is the authority.                                                       |
| Run workers as the same role as the API with extra claims | Removes the separation that keeps `service_role` out of request handlers.                                                                             |
| Database per tenant                                       | Strongest isolation but multiplies operations and breaks the borrower's multi-lender view; kept as an option on a contractual requirement (ADR-0005). |

## Consequences

**Positive**

- One short rule to review any change against; new modules and integrations have a template.
- Isolation holds even when route code has a bug, and is demonstrated by tests.

**Negative**

- The rule constrains convenience: a worker cannot be given a tenant id and told to get on with it; each handler must load and check the row.
- The system role bypasses row level security by design; point 6 limits where it may be used but the code inside those folders is trusted code and needs the most careful review.
- Policies and helper functions add query cost and complexity (ADR-0005).

**Risks**

- A future shortcut (for example a request handler importing a system function) would silently remove the second layer. The lint rule and boundary test are the guard; keep them.
- Point 7 relies on review for each new handler until a more mechanical check exists.

## Compliance and security notes

- Supports lender requirements to keep each lender's data isolated (research: likely, `docs/research/2026-10-10/privacy-security-outsourcing.md`). This ADR does not claim compliance; the evidence is the test suite and the review record.
- Primary-source verification gate applies (README).

## Verification

- `supabase/tests/002_tenant_isolation.test.sql`, `006_authorization_matrix.test.sql`, `008` to `012` (cross-tenant negatives).
- `services/api/test/user-context.test.ts`, `login-posture.test.ts`, `boundary.test.ts`, `token-verifier.test.ts`.
- API integration tests with a real database (`services/api/test/integration/*`): cross-tenant refusal, system login boundary, worker behaviour.
- Planned: a test that fails when a worker handler or system function takes a tenant id from its message without reading the row.

## Revisit triggers

- A lender requires physical separation or lender-held keys that change the data layout.
- A second deployable needs database access (any new process that would hold the system login).
- A caller type appears that is neither a person, a worker nor a signed callback.
- Any write path is proposed that bypasses the per-request transaction.
