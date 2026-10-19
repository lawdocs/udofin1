# ADR-0007: The lender's LMS is the loan system of record

- **Status:** Accepted (baseline, pending owner approval)
- **Date:** 2026-10-10
- **Related:** ADR-0008, ADR-0011, ADR-0015, ADR-0023, ADR-0024

## Context

- Udofin is an LSP: an agent of the lender for functions such as acquisition, servicing support and (if appointed) recovery. The lender keeps responsibility for underwriting, servicing and NPA recognition (research: confirmed (secondary), `docs/research/2026-10-10/rbi-digital-lending.md` §3.1, §3.15).
- Loan accounting (balances, accrual, allocation of receipts, penal charges, provisioning, bureau reporting) is the lender's function. Lenders report every digital-lending loan to credit bureaus, weekly from 1 Jul 2026 (research: confirmed (secondary), DL-21).
- Each lender has, or will choose, a loan management system (LMS): Finbyx (a separate group product), a third-party LMS, or manual files.
- Research assessed Apache Fineract as an embedded ledger: India-specific behaviour (IRACP, CIC formats, NACH, DLG accounting, KFS/APR, Ind AS 109) would have to be built, it needs JVM skills, and its README says its Docker images are not production-ready (`infra-stack.md` §10; confirmed for README statements, interpretation for fit).

## Decision

1. Udofin is **not** the system of record for loans. The lender's LMS owns balances, schedules, allocation of receipts, accrual, provisioning, accounting and bureau reporting.
2. Udofin keeps an **immutable read model** of what the LMS reported, to show the borrower and to reconcile:
   - `servicing.loan_accounts`: one per application; `source_system` is `finbyx`, `lender_lms` or `manual_import`; `lms_loan_ref` unique per lender; `last_synced_at`.
   - `servicing.schedule_snapshots` and `schedule_installments`: append-only, versioned exactly as received; a new version supersedes the old.
3. **Disbursement evidence:** date, amount and bank reference (for example UTR) must be recorded together or not at all; disbursed amount cannot exceed sanctioned amount. An application can be marked `disbursed` only when that evidence exists for the same lender. Approval alone never moves money and never makes an application "disbursed".
4. Integration with each LMS goes through an `LmsPort` adapter in `packages/adapters` (port added in the phase that first uses it), Finbyx first, then generic REST or file import.
5. Borrower-facing balances and schedules are presented as the lender's figures with their sync time, never as Udofin's own calculation.
6. Udofin's **own** books (LSP fees receivable from lenders, DLG exposure, collection fees) need double-entry accounting, planned for Phase 9. Tally and SAP are export destinations, not ledgers.

## Alternatives considered

| Option                                                 | Why rejected                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Udofin runs its own loan ledger alongside the lender's | Two competing balances; reconciliation disputes; Udofin would be performing the lender's accounting function.                                                      |
| Embed Fineract (or another LMS) inside Udofin          | Same as above, plus India-specific build-out and JVM skills (research). If a lender has no LMS, Finbyx is offered as a separate product under a separate contract. |
| Mutable mirror tables updated in place                 | Loses the evidence of what the lender reported and when; cannot prove what the borrower was shown.                                                                 |

## Consequences

**Positive**

- No conflicting "source of truth" for balances; disputes are settled against the lender's records.
- The append-only snapshots form evidence of what the lender reported and when.
- Udofin's regulatory footprint stays narrower.

**Negative**

- Borrower views can be stale between syncs; the UI must show the sync time.
- Each LMS needs its own adapter, mapping and reconciliation; manual imports need operational controls.
- Udofin depends on lenders' data quality and availability for servicing features (reminders, foreclosure quotes).

**Risks**

- Finbyx is a group product that would hold lenders' loan records while those lenders oversee Udofin; this is a conflict of interest to disclose and manage (ADR-0024).
- The Finbyx Supabase project was found in Tokyo (ap-northeast-1), which is a residency problem for any lender data (research: confirmed; ADR-0010).
- Known gap: `servicing.loan_accounts.borrower_id` is not constrained to the application's borrower (ADR-0005).

## Compliance and security notes

- Supports the reported division of duties: the lender keeps loan accounting, NPA recognition and bureau reporting (research: confirmed (secondary)).
- Disbursement must go to the borrower's own account (ADR-0008); the evidence rule records that it happened, it does not verify the beneficiary.
- Primary-source verification gate applies (README).

## Verification

- `supabase/tests/003_lifecycle_and_integrity.test.sql`: "approval and agreement alone never make an application disbursed"; "disbursement evidence must be complete (date, amount and bank reference together)"; with evidence recorded the system marks it disbursed; "disbursed is terminal"; "received schedules cannot be edited".
- `supabase/tests/002_tenant_isolation.test.sql`: lender staff see only their own loan accounts and schedules; borrowers see only their own.
- Planned: reconciliation job comparing the read model with LMS reports, with alerts on drift.

## Revisit triggers

- A lender asks Udofin to compute or host its loan ledger (answer: Finbyx as a separate product, or a new ADR).
- Udofin takes on DLG or recovery-agent roles that need its own ledgers (Phase 7/9; ADR-0023).
- Regulatory change to LSP servicing duties.
