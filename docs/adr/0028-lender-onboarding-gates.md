# ADR 0028 — Lender onboarding: separate gates, versioned records, function-only writes

**Status:** Accepted (pending owner review of the Phase 04 PR) · **Date:** 13 Oct 2026

## Context

The platform must onboard many lenders of different institution types (NBFCs, banks, urban co-operative banks, future entities) without a module per type, record each lender's accounting framework and Ind AS status without concluding anything automatically, record what Udofin does for each lender, and keep any lender, service or product from going live by accident. Several of the governing regulatory texts are not on file.

## Decision

1. **One lender module, configurable categories.** `onboarding.institution_categories` holds the types. Each carries a regime status (confirmed_primary / likely / unverified) and `activation_allowed`. Unverified categories cannot be activated until the compliance officer records a sign-off citing the primary source; a constraint enforces this.
2. **Facts and verification are separate.** Profiles and accounting records are declarations. Verification is a distinct state that needs evidence, an independent reviewer and (for accounting) confirmed values; history rows are append-only.
3. **Ind AS: applicability and implementation are separate fields, no derived conclusions.** Nothing reads net worth, listing or lender type to set them.
4. **Versioned, immutable once agreed.** Accounting profiles and service versions are new rows per change; submitted/agreed rows cannot be edited (triggers). A live service keeps running while a new version is agreed and activated.
5. **Writes only through SECURITY DEFINER functions.** Users have SELECT only through RLS (`onboarding.read`). Functions check permission and MFA first, then rules; the API repeats the permission check.
6. **Gates are sequential, requested and decided by different people, and conditions are re-checked at decision.** Approving a lender never approves products, services, integrations or commercial terms.
7. **Borrower visibility** is a view (`lending.borrower_visible_product_versions`) requiring an activated, unsuspended lender; discovery must read only it.
8. **Audit by trigger** on every onboarding table (column names and enumerated transitions only), plus explicit events for document retrieval. Rows are never deleted.
9. **Documents** go to a private store port; bytes never reach the database; local adapter is development-only.

## Consequences

Positive: one code path for all lender types; no auto-approval path exists; history survives; cross-tenant isolation is enforced twice. Negative: more steps for onboarding staff; every rule lives in SQL so changes need migrations. Risks: the production-readiness evidence standard for Ind AS is a policy choice (D-32); bank/UCB regulation is unverified (D-31).

## Verification

`supabase/tests/008_onboarding.test.sql` (137 assertions), `services/api/test/integration/onboarding.integration.test.ts`, `packages/portal-kit/test/onboarding.test.tsx`, updated authorisation matrix (`006`).
