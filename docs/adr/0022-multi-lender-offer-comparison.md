# ADR-0022: Multi-lender offer comparison

- **Status:** Proposed — the offer data model exists; the comparison service, matching rules and display log are not built
- **Date:** 2026-10-10
- **Related:** ADR-0014, ADR-0015, ADR-0020, ADR-0021

## Context

Research findings (`docs/research/2026-10-10/rbi-digital-lending.md` §3.4–3.6, DL-05, DL-06, DL-08, DL-30):

- An LSP with arrangements with several lenders must show a digital view of **all** offers matching the borrower's request from all its lenders, and **name the lenders that did not match**. The view must be unbiased and objective, follow a consistent, documented matching method, and contain no dark patterns that steer the borrower to a lender. Each offer shows lender name, amount, tenor, APR, monthly repayment, penal charges if any, and a link to the KFS. Reported as paragraph 6 (and 6(iii)) of the 8 May 2025 Digital Lending Directions, effective 1 Nov 2025, now reportedly in the Credit Facilities Directions. Status: confirmed (secondary); paragraph numbers in the consolidated instruments unverified.
- One KFS per offer; APR is the all-inclusive cost; KFS before the contract is executed (confirmed (secondary)); KFS validity window details likely.
- The lender pays the LSP; the borrower is never charged by the LSP (confirmed (secondary)).
- From 1 Jan 2027, the RBC (Second Amendment) Directions add the dark-pattern ban and user testing (confirmed (secondary)).
- Udofin earns fees from lenders, which creates an incentive to rank higher-paying lenders first.

## Decision

1. **Show every matching offer** for a loan request, and **list by name every partner lender that did not offer** (without exposing their reasons unless the lender provides borrower-facing text).
2. **Each offer card shows:** lender name, amount, tenor, APR, monthly (instalment) repayment, penal charges, and a link to the offer's KFS. These come from the immutable offer row (`lending.offers`: `principal_minor`, `tenure_days`, `installment_*`, `apr_bps`, `penal_charges_summary`, `kfs_document_id`).
3. **Neutral, documented ordering:** default sort by a borrower-relevant measure (for example APR), or an order the borrower chooses. Ordering never depends on Udofin's commercial terms. No "recommended" or "best" badges driven by fees; no pre-selection; equal visual weight for all offers.
4. **Versioned matching rules:** the rules that decide which lenders receive a request and which offers are "matching" are written down, versioned and published; each request records the rules version used.
5. **Data goes to a lender only after consent** for that lender (ADR-0014).
6. **Display log:** every rendering of the comparison is recorded — request, rules version, offers shown with their order, unmatched lenders named, channel and app version — so any screen can be reproduced for a lender, auditor or complaint.
7. **Channel rules apply** (ADR-0020): offers violating store rules for a channel (for example above 36% APR on iOS, pending verification) are suppressed there, and the suppression is logged.
8. **Udofin never charges the borrower.** LSP fees appear only in B2B invoices to lenders.

## Alternatives considered

| Option                                          | Why rejected                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Show only the "best" offer                      | Contradicts the reported requirement to show all matching offers and name unmatched lenders. |
| Rank by Udofin's commission or partnership tier | Fee-driven steering; dark pattern (research).                                                |
| Lender-paid placement ("featured lender")       | Same as above.                                                                               |
| Do not log displays                             | No way to prove what the borrower saw; weak defence in complaints.                           |

## Consequences

**Positive**

- Borrowers can compare like with like; lenders compete on terms.
- Display logs give evidence for lender audits and complaint handling.

**Negative**

- Weaker commercial levers for Udofin; lenders cannot buy placement.
- Display logs add storage volume; retention must be decided.
- Waiting for all lenders to respond may slow the screen; partial results need clear "still waiting" states without steering.

**Risks**

- Subtle UI choices (colour, position, default selection) can still steer; design review and user testing are needed before 1 Jan 2027 (ADR-0021).
- Matching rules that exclude lenders without explanation could be seen as biased; rules must be documented and consistent.

## Compliance and security notes

- Supports the reported multi-lender display, KFS and LSP-fee rules (labels above). Evidence (planned): matching-rule document and version history; display logs with all offers and unmatched lenders.
- Primary-source verification gate applies (README); the paragraph references must be checked against the consolidated Credit Facilities Directions for each lender type.

## Verification

Planned (research DL-08):

- With three lenders of which one does not offer, the screen lists two offers with all six fields and KFS links and names the third lender.
- Changing Udofin's commission for a lender does not change the order.
- Every render produces a display-log entry that can reproduce the screen.

## Revisit triggers

- Primary-text review of the display requirements.
- RBC Second Amendment user-testing results.
- Introduction of pre-approved or instant offers that change the matching flow.
