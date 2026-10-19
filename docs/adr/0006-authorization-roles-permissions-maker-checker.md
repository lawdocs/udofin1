# ADR-0006: Authorisation — organisations, roles, permissions and maker-checker

- **Status:** Accepted (baseline, pending owner approval)
- **Date:** 2026-10-10
- **Related:** ADR-0005, ADR-0013, ADR-0015, ADR-0024

## Context

- The lender, not Udofin, makes the credit decision; the LSP may support underwriting but not decide (research: confirmed (secondary), `docs/research/2026-10-10/rbi-digital-lending.md` §3.8, DL-11).
- Udofin staff must handle exceptions across lenders without being able to change lenders' decisions or records.
- Loan product terms (amounts, tenures, rate bands, fees) drive what borrowers are offered. A single person changing them without review is an operational and conduct risk.
- Staff access must be removable at once (suspension, expiry) and must not depend on a cached token.

## Decision

1. **Organisations** have a kind: `platform` (exactly one: Udofin), `lender`, or `service_partner` (for example a collection agency engaged by a lender). A lender cannot leave `onboarding` status without a regulator registration number (`lender_needs_registration` constraint).
2. **Permissions** are a catalogue managed only by reviewed migrations. Each has two flags: `platform_grantable` (a platform role holding it applies across all lenders) and `platform_only` (never allowed on a tenant role).
3. **Roles** carry permissions. System roles exist for every organisation of a kind; organisations may add custom roles. **Memberships** link a user to an organisation with a status (`invited`, `active`, `suspended`, `revoked`) and optional `valid_until`; membership roles link memberships to roles.
4. **Database guards** (triggers): a role can be granted only to a member of an organisation of the kind it applies to (a lender member can never hold a platform role), and a tenant role can never carry a `platform_only` permission.
5. **Credit decisions** (`application.decide`) are lender-only: the permission is not platform-grantable.
6. **Maker-checker for product versions:** the approver must differ from the drafter (`maker_checker` check constraint, enforced even for the system); in user context the approver must be the current user and hold `product.approve` for that lender; approved versions are immutable (only `approved → retired`); only categories enabled on the platform can be approved; tenure can never go below the category floor (ADR-0020).
7. Permission checks read the membership tables on every statement (not JWT role claims), so suspension takes effect immediately.
8. Staff authenticate with email and MFA; SAML SSO later. Group-level SSO across ecosystem products is allowed only with segregation-of-duties rules (ADR-0024).

### Baseline role matrix (system roles, `supabase/migrations/20261010000200_tenancy_and_access.sql`)

| Role (kind)                 | Permissions                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| lender_admin (lender)       | org.members.read, org.members.manage, product.read, product.configure, application.read, loan.read, payment.read, audit.read |
| credit_officer (lender)     | product.read, application.read, application.decide, loan.read                                                                |
| product_approver (lender)   | product.read, product.approve                                                                                                |
| viewer (lender)             | product.read, application.read, loan.read, payment.read                                                                      |
| platform_admin (platform)   | platform.organizations.read, platform.organizations.manage, platform.consent_notices.manage, org.members.read                |
| operations_agent (platform) | platform.organizations.read, product.read, application.read, loan.read, payment.read                                         |
| auditor (platform)          | platform.organizations.read, product.read, application.read, loan.read, payment.read, audit.read                             |

Platform-grantable permissions: org.members.read, product.read, application.read, loan.read, payment.read, audit.read. Platform-only: platform.organizations.read, platform.organizations.manage, platform.consent_notices.manage.

## Alternatives considered

| Option                                                                     | Why rejected                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role checks only in API code                                               | No second layer; a bug grants access (ADR-0005).                                                                                                  |
| Roles carried as JWT claims (e.g. via a Supabase Custom Access Token hook) | Claims stay valid until the token expires, so suspension is not immediate. Claims may still be added later for routing, but not as the authority. |
| Fixed roles with no permission catalogue                                   | Lenders' organisational structures differ; custom roles need a catalogue to compose from.                                                         |
| Maker-checker only in the UI or API                                        | Bypassable by scripts or other clients; the database constraint holds for every writer.                                                           |

## Consequences

**Positive**

- Segregation of duties is enforced in the database and tested.
- Udofin operations can see across lenders but cannot decide, edit or accept on anyone's behalf.
- Removing a person's access is one status change.

**Negative**

- Every policy evaluation joins membership tables; helpers must stay indexed and cheap.
- Changing the permission catalogue needs a migration and review, which is slower than a configuration screen.

**Risks and known gaps (baseline)**

- Maker-checker relies on distinct humans. A `lender_admin` can manage members and could create a second account to approve their own draft. Mitigation: staff identity proofing and lender-side review of role grants (to be designed).
- When the **system** records an approval (no user session), the database checks only `approved_by <> drafted_by`, not that the approver belongs to the lender. The shared test fixture itself records lender B's product version as approved by a lender A user.
- Consent notice publication (`platform.consent_notices.manage`) has no database maker-checker: `consent.notices` has `approved_by` but no drafter column.
- Organisation onboarding and role grants are written by the API under `service_role`; the permission checks for those workflows are API-only and not yet built.
- In the database, any authenticated non-borrower acting on an application is labelled `lender`, including platform staff (ADR-0015).

## Compliance and security notes

- Supports the rule that credit decisions stay with the lender (research: confirmed (secondary)), and lenders' expectations of access control and segregation of duties under IT-outsourcing flow-down (research: likely).
- Primary-source verification gate applies (README).

## Verification

- `supabase/tests/003_lifecycle_and_integrity.test.sql`: a user without `product.approve` cannot approve; the drafter can never be recorded as approver, even by the system; a separate approver publishes; approved terms are immutable; a lender member can never be given a platform role; a lender role can never carry a platform-only permission; staff accounts never become borrower accounts; lender staff cannot accept an offer for the borrower; a borrower cannot approve.
- `supabase/tests/002_tenant_isolation.test.sql`: viewer cannot modify applications; ops agent is read-only; staff with no role see nothing; suspended membership loses access.

## Revisit triggers

- A lender asks for custom permissions beyond the catalogue, or for four-eyes approval of other actions (offers, credit decisions).
- SAML SSO is introduced, or group-wide SSO across ecosystem products.
- Any known gap above is closed or exploited.
