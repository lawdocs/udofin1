# ADR-0023: Collections and default loss guarantee (DLG) kept separate

- **Status:** Proposed — nothing is built; whether Udofin will provide DLG and/or act as a recovery agent are open owner decisions
- **Date:** 2026-10-10
- **Related:** ADR-0007, ADR-0008, ADR-0016, ADR-0018

## Context

Research findings (`docs/research/2026-10-10/rbi-digital-lending.md` §3.14–3.15, DL-22 to DL-28; `grievance-adr-collections.md`):

- **DLG creates no right or duty to collect.** Collection is a separate function the lender outsources (confirmed (secondary)).
- **DLG rules:** the provider must be an LSP (or a lender acting as LSP) incorporated under the Companies Act, 2013; the lender needs a board-approved DLG policy and an enforceable contract; total cover on a portfolio may not exceed **5% of the amount disbursed** out of that portfolio (the "DLG set"), fixed once earmarked, not reinstated after invocation; permitted forms are cash with the lender, a fixed deposit with a scheduled commercial bank under lien to the lender, or a bank guarantee; invocation within **120 days overdue**; the lender still recognises NPAs and provisions; the LSP must publish on its website the number of portfolios covered and the amount of each; no DLG on digitally offered revolving credit, credit-guarantee-scheme loans or P2P (confirmed (secondary)). From 13 Feb 2026 NBFCs using ECL may count DLG only if it is integral to the loan contract (confirmed (secondary); reference number unverified).
- **Recovery:** an LSP may collect only as the lender's disclosed recovery agent under the outsourcing contract; the lender names the recovery agent at sanction and notifies the borrower before a new agent makes contact (confirmed (secondary) in `rbi-digital-lending.md`; likely in `grievance-adr-collections.md`). Calls only 08:00–19:00, no harassment or third-party contact (likely). The 6 Aug 2026 recovery Amendment Directions, effective 1 Jan 2027, add IIBF certification, advance notice of first visit, recorded calls kept 6 months, an agency list updated within 7 days and device-lock limits (confirmed (secondary); details need the text).
- Being both the loss absorber and the collector creates an incentive toward aggressive collection (research interpretation).

## Decision

1. **DLG and collections are separate modules with separate switches.** Providing DLG to a lender never enables collections. Collections for a lender are enabled only by a separate, recorded recovery-agent mandate from that lender, and stop when the mandate is withdrawn, even if DLG remains.
2. **DLG ledger (Phase 7/9):** per lender and per DLG set: disbursed amount, cover, form (enumerated to cash, FD with lien, bank guarantee only), contract and policy references, invocations; automatic cap check that blocks cover above 5% of disbursed; no reinstatement entries; days-past-due alerts before the 120-day limit; a generated public disclosure page.
3. **Udofin's own books** for DLG exposure, fees and collection income use double-entry accounting (ADR-0007), not the lender's LMS.
4. **Collections (only if appointed):** run under each lender's recovery policy; contact windows, frequency caps and recorded calls enforced by the system; borrower notified before first contact; agent registry with certification and expiry; only the lender's repayment rails, never a Udofin account (ADR-0008); no access to the borrower's contacts or device data (ADR-0016); no use of DLG status in borrower communications.
5. Complaints about collection conduct follow the grievance path (ADR-0018) and are monitored per lender.

## Alternatives considered

| Option                                               | Why rejected                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| "Udofin provides 5% FLDG, therefore Udofin collects" | DLG gives no collection right (research); conflict of interest.    |
| Track DLG in spreadsheets                            | Cap breaches and missed invocations are likely; no evidence trail. |
| One combined "risk and recovery" module              | Makes it easy to couple DLG exposure to collection intensity.      |

## Consequences

**Positive**

- Udofin's DLG exposure and collections conduct can be evidenced separately to lenders and auditors.
- Collections can be switched off per lender without touching DLG.

**Negative**

- Two modules, two contracts per lender, separate reporting.
- DLG ties up Udofin capital across lenders; capacity must be modelled before offering it.

**Risks**

- Legal characterisation of large guarantee exposures for Udofin needs advice (research open question).
- If Udofin is not incorporated under the Companies Act, 2013, it cannot provide DLG (owner decision on legal entity).

## Compliance and security notes

- Supports the reported DLG and recovery rules (labels above). The recovery rules effective 1 Jan 2027 must be read in the primary text before the collections module is designed in detail. Primary-source verification gate applies (README).

## Verification

Planned (research DL-22 to DL-27, GR-10, GR-15):

- Adding cover above 5% of a set's disbursed amount fails; a "corporate guarantee" DLG record cannot be created; recoveries do not restore cover.
- Withdrawing the recovery mandate stops collections even with DLG active.
- A call scheduled at 19:01 is blocked; contact before the agent-assignment notice is blocked.

## Revisit triggers

- Owner decisions on the legal entity, DLG provision and recovery-agent role.
- Primary-text review of the 1 Jan 2027 recovery rules.
- Final rules on NBFC revolving credit (affects DLG eligibility of products).
