# ADR 0030: Lender routing, consented sharing, lender-reported status, offers and comparison

Date: 2026-10-13. Status: proposed for owner approval (Phase 06). Related: ADR 0007, 0008, 0014, 0015, 0022, 0025.

## Context

Udofin facilitates; lenders decide (ADR 0007). Phase 06 lets a borrower choose up to five lenders, share a fixed
minimum with each only after a separate consent, follow lender-reported progress, and compare lender-supplied offers.

## Decisions

1. **Database is the authority.** Routing, consent revalidation, transmission start, lender events, offer intake and
   comparison are `SECURITY DEFINER` functions with `search_path=''`, called with the caller's own role. Tables are
   forced-RLS with cross-tenant pgTAP tests.
2. **The phone number is never stored by Udofin outside the sign-in provider.** `lending.begin_transmission` reads it
   from the authentication store inside the same transaction that revalidates consent under a row lock, and returns it
   to the worker only for that one send. The lender's portal can show it through an audited call that refuses after
   consent is withdrawn. Tests scan the lending, consent, audit and outbox tables for a canary number.
3. **Withdrawal versus sending is serialised** by locking the routing row in both paths.
4. **A timeout is not a rejection.** An uncertain send is recorded `uncertain` and reconciled through the connector's
   lookup; it is never blindly resent.
5. **One entry point for lender data.** Manual portal entry and signed callbacks call the same private `apply_*`
   functions, so rules cannot diverge. Callbacks are de-duplicated by message id and recorded when rejected.
6. **The callback receiver is a separate small service** (`pnpm --filter @udofin/api callbacks`) so the public API never
   holds the system database login (boundary test). It verifies the signature over the raw bytes before the database
   sees anything. Only a mock scheme exists; real `api` connectors return 503 until a scheme is specified (D-43).
7. **Offers are stored exactly as supplied.** Udofin validates structure and the KFS link host and never recalculates
   APR or instalments. Failures are held for correction and never shown. Revisions keep history.
8. **Comparison is evidence.** `compare_offers` records the run, every displayed offer with rank and rule version, and
   every named non-offering lender. It refuses to order anything until a platform rule is approved by two people (D-16).
9. **No vendor integrations, no Finbyx, no AWS KMS adapter** in this phase (D-13, D-04, D-47).

## Consequences

- Without approved consent wording for a lender (D-37, D-42), sharing with that lender is blocked, by design.
- A lender can still hold data after the borrower withdraws consent; the product says so (D-41).
- The baseline grants still let lender database roles update application rows directly; portal and API use only the
  functions. Tightening those grants is recorded as a follow-up in the security review.
