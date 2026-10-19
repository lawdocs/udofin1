# ADR-0025: Two-person change control for administrative changes

- **Status:** Accepted (13 October 2026, as part of the approved Phase 02 specification)
- **Date:** 2026-10-13
- **Related:** ADR-0005, ADR-0006, ADR-0013, ADR-0014; spec `docs/specs/02-database-security.md` (W2)

## Context

Organisations, memberships, role grants and published consent wording decide who may act for whom and what borrowers are told. In Phase 01 nothing controlled how they were written: "the API under the system role" could change any of them with no second person and no audit. A single compromised or careless administrator could add themselves to a lender or publish consent wording alone.

## Decision

1. Seven change types go through **change requests**: `organization.create`, `organization.activate`, `membership.invite`, `membership.suspend`, `role.grant`, `role.revoke`, `consent_notice.publish`.
2. **One person requests, a different person approves.** Both must hold the permission for that type at the time of requesting, approving **and applying**. The database enforces requester ≠ approver (check constraint and function logic), a seven-day expiry, immutability of a filed request, and a fixed status flow.
3. **Only staff sessions that completed the second factor** (`aal2`) may file or decide. The API checks this and the database functions check it again from the token claims.
4. The change is **applied by the system role in one transaction** with its audit event (`private.apply_change_request`, callable only by `service_role`). Direct inserts, deletes and status changes on organisations, memberships and role grants by any other path are refused by triggers (the database owner, used for the break-glass bootstrap, is exempt).
5. Idempotency: filing is idempotent per requester and key; a key reused with different content is refused.
6. Segregation rules that apply regardless of approval: platform staff and lender staff are separate logins; a login cannot hold both `collections.work` and `dlg.manage`; a borrower login cannot be staff.

## Alternatives considered

| Option                                    | Why rejected                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| Application-level checks only             | A code path or credential with the system role could skip them; no independent evidence. |
| One administrator, audited after the fact | Detects but does not prevent a single person's misuse.                                   |
| Approval workflow in an external tool     | Another system to trust; the audit event must be in the same transaction as the change.  |

## Consequences

**Positive** — no single person can onboard a lender, add staff, grant a role or publish consent text; every administrative change has two named people and an audit record.
**Negative** — launch needs two named platform administrators; an approved request whose application fails (for example a segregation rule) stays approved and visible, and needs a retry path that a later phase adds as a worker sweep.
**Risks** — the system role can still set the transaction flag that the guard reads; that residual risk is limited by the import boundary, the boot guard and review, and is recorded in the threat model.

## Verification

`supabase/tests/005_phase02_change_control.test.sql` (direct writes refused, MFA, idempotency, self-approval, expiry, loss of entitlement before applying, segregation) and `services/api/test/integration/api.integration.test.ts` (end-to-end through HTTP, cross-tenant refusal).

## Revisit triggers

A third approval tier for sensitive types; the first lender that requires its own approver for changes inside its organisation; moving approval to an external identity governance tool.
