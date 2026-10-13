# ADR-0023: Collections and default loss guarantee (DLG) kept separate

- **Status:** Accepted (13 October 2026). Owner decision: Udofin provides a 5% DLG and acts as a recovery agent for lenders, and other recovery agencies may also be used. Implementation is Phase 08; Phase 02 adds only the permission keys and the segregation rule.
- **Date:** 2026-10-10, rewritten 2026-10-13 against the primary RBI texts
- **Related:** ADR-0007, ADR-0008, ADR-0016, ADR-0018, ADR-0025. Detailed design: [`../architecture/collections-and-dlg.md`](../architecture/collections-and-dlg.md). Sources: `docs/regulatory/primary/01`, `06`, `09`, `10`.

## Context

What the supplied RBI texts say (paragraph numbers are in the primary notes):

- **DLG** (Credit Facilities Directions, Chapter III): cover capped at **5% of the amount disbursed out of a fixed "DLG set"**, activated proportionally as loans are disbursed; forms limited to **cash with the lender, a lien-marked fixed deposit, or a bank guarantee**; invocation within **120 days overdue**; no reinstatement after recoveries; the lender's policy sets provider eligibility and every arrangement needs a **declaration certified by the provider's statutory auditor** (para 20(3)); monthly disclosure within seven working days; the provider must be a Companies Act, 2013 company. A DLG is not a substitute for credit appraisal.
- **Provisioning (IRAC 36A–36C):** a lender may count a DLG in expected credit loss only if it is integral to the loan contract. Nothing in the text lets DLG change days past due, SMA or NPA dates or upgrade eligibility.
- **Capital (Capital Adequacy):** no recognition of a private DLG as credit risk mitigation for retail loans. An NBFC that provides a DLG must deduct it from its own capital (para 15(3)), so Udofin must not become an NBFC provider. Do not market DLG as capital relief.
- **Recovery:** a recovery agent is any agency the lender engages, and Udofin is one; the lender answers for its conduct. Hard platform limits: **no recovery calls before 08:00 or after 19:00**, no intimidation, humiliation or contact with family or friends, no persistent calling, agent details given to the borrower before recovery starts, police verification of collectors, an agent undertaking and training (RBC paras 91–100). Penal charges are flat, on the overdue amount only, and each reminder must state them (RBC para 30). Money moves only into the lender's account (Chapter III paras 10(2)–(3)).
- Being both loss absorber and collector is a conflict of interest the text does not forbid but a lender will examine.

## Decision

1. **DLG and collections are separate modules with separate switches.** Providing DLG to a lender never enables collections. Collections are enabled per lender by a recorded **recovery-agent mandate**, and stop when it is withdrawn, even if the DLG remains.
2. **Udofin may act in both roles. The architecture enforces the separation:**
   - one login cannot hold both `collections.work` and `dlg.manage` (database rule, migration `0700`);
   - collections staff cannot read DLG tables or per-loan invocation status; DLG staff cannot contact borrowers;
   - DLG status is never used in borrower communications, and recovery incentives never depend on DLG exposure;
   - every contact attempt is an append-only record.
3. **DLG ledger (`dlg` schema, Phase 08):** arrangement, set, member loans, disbursement events, cover instruments, invocations, recovery shares, disclosures, auditor declarations. Cover above 5% of disbursed in a set is refused; cover instruments must be one of the three permitted forms; no reinstatement entries; invocation after day 120 is refused unless the lender records an exception (flagged for review); a shortfall between cap and committed cover blocks new disbursements into the set (the lender decides).
4. **Servicing facts stay lender-owned.** DPD, SMA and NPA dates come from the lender's LMS; the DLG ledger stores invocation amount, remaining cover and date so the lender can recompute expected credit loss. A collections grace period may delay **contact**, never the overdue date.
5. **Collections (`collections` schema, Phase 08):** case state machine with a `notice_pending → contactable` gate (agent details and notice sent first); calling hours clamped to the regulatory window whatever the lender's policy; the contact log and complaints link; payment links only in the lender's name against the lender's account (ADR-0008); settlement and restructuring requests are forwarded to the lender, which alone decides; sub-collection agencies are sub-contractors that need the lender's consent (outsourcing directions).
6. **The legal entity is Infrabyx Consultancy OPC Private Limited.** The owner's position is that an OPC may act as DLG provider. Counsel must confirm this together with the auditor certification and the capital to support cover; the system records the legal entity and the evidence, and never presents Udofin as a lender or guarantor of the borrower.

## Alternatives considered

| Option                                            | Why rejected                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| "Udofin provides DLG, therefore it collects"      | DLG gives no collection right and the roles stay separate.                    |
| One combined "risk and recovery" module           | Makes it easy to couple DLG exposure to collection intensity.                 |
| Track DLG in spreadsheets                         | Cap breaches and missed invocations are likely; no evidence trail.            |
| Udofin collects money and passes it to the lender | Prohibited: no pass-through or pool accounts (ADR-0008; Chapter III para 10). |

## Consequences

**Positive** — DLG exposure and collections conduct can be evidenced separately to lenders and auditors; collections can be switched off per lender without touching DLG.
**Negative** — two modules and two contracts per lender; cover instruments tie up Udofin capital (cash, a lien-marked FD or a bank guarantee from the first disbursement), so capacity must be modelled before a lender is signed.
**Risks** — the legal capacity of an OPC to give large guarantees, the statutory-auditor certification, and the conflict of interest if segregation is weakened. The amendments after 1 April 2026 (recovery rules of 6 August 2026) are not in the supplied text and must be obtained.

## Verification

Planned acceptance tests (Phase 08) reproduce the three DLG illustrations in Chapter III para 24(3); cover above 5% fails; a corporate-guarantee instrument cannot be created; recoveries do not restore cover; a call scheduled at 19:01 is blocked; contact before the agent notice is blocked; withdrawing the mandate stops collections with DLG still active. Phase 02 already tests the segregation rule in `supabase/tests/005_phase02_change_control.test.sql`.

## Revisit triggers

Primary text of the 6 August 2026 recovery amendment; final rules on revolving credit; counsel's view on the OPC as provider; any lender that requires different cover forms.
