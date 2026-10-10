# ADR-0018: Grievance path, and Equator only as an optional later referral

- **Status:** Proposed — no grievance module exists yet; Equator's domain, brand and independence model are open owner decisions
- **Date:** 2026-10-10
- **Related:** ADR-0014, ADR-0015, ADR-0019, ADR-0023, ADR-0024

## Context

Research findings (`docs/research/2026-10-10/grievance-adr-collections.md`, `rbi-digital-lending.md` §3.11, `ecosystem-sites.md` §4):

- The lender and the LSP must each name a nodal grievance redressal officer, shown on the lender's and LSP's websites, the DLA and the KFS; grievance redressal stays the lender's responsibility (confirmed (secondary) in `rbi-digital-lending.md` DL-18; likely in `grievance-adr-collections.md` GR-06, GR-07).
- **RB-IOS 2026** (issued 16 Jan 2026, in force 1 Jul 2026, replaced RB-IOS 2021): the borrower complains to the lender first; may go to the RBI Ombudsman if there is no reply within 30 days or the reply does not satisfy them; must file within **90 days** of the later of that timeline's expiry or the lender's last communication (confirmed, RBI FAQ via search extract). A complaint is **not maintainable** if the same grievance is pending before, or decided by, a court, tribunal, arbitrator or other forum (confirmed, lender-published salient features).
- RB-IOS coverage of NBFCs depends on a customer interface; whether the ₹100 crore asset threshold still applies, and whether HFCs are covered, is unverified. A small partner NBFC may fall outside the scheme.
- Equator is a group-affiliated ADR platform. An Equator **arbitration** would make the Ombudsman complaint non-maintainable; a **mediation** after the lender's final reply could use up the 90-day window; common ownership with an LSP that may provide DLG creates a conflict of interest (interpretation; arbitrator-independence points are likely).
- `equator.in` is indexed as an unrelated facility-management company (confirmed: search index; ownership unverified). The group's ODR platform appears to be Equa.Law (`equa.law`) (likely). No evidence was found that it is a recognised mediation service provider (confirmed: search negative). Mediation Act commencement is unverified.

## Decision

1. **Complaint facility everywhere:** in-app and web complaint entry on every screen. Every channel (form, email, chat/AI, voice, assisted) creates a ticket with a UTC timestamp and the lender it concerns.
2. **Two linked records:** a Udofin ticket (front desk) and the lender's grievance case (authoritative). Tickets route to Udofin's nodal grievance officer and to the lender's grievance officer / nodal officer the same business day. Udofin's receipt is treated as the lender's receipt for the clock.
3. **The lender decides.** Udofin cannot finally reject a matter the lender owns.
4. **Ombudsman information is automatic:** at day 30 without resolution, or on any final reply or rejection, the borrower is shown the RB-IOS route, the complaint portal link and the computed 90-day deadline. Each lender's master data holds its grievance officer, principal nodal officer and an "RB-IOS covered" flag; a lender without complete data cannot go live.
5. **AI** may open tickets and answer status questions, but never closes, rejects or settles a complaint (ADR-0019).
6. **Equator referral rules:**
   - never the default, never before or instead of the lender's process or RB-IOS;
   - offered only after the lender's final reply or day 30, as an optional, opt-in, **mediation-first** route;
   - group affiliation disclosed; the Ombudsman deadline shown alongside; an unaffiliated alternative shown;
   - a separate consent for sharing data with Equator (consent-token referral; ADR-0014, ADR-0024);
   - **no arbitration referral for retail borrowers**, and no pre-dispute arbitration clauses in retail loan documents.
7. **No hard-coded Equator domain or brand** in journeys, KFS or notices until the owner confirms which domain the group controls (`equator.in` vs `equa.law`) and the trademark.
8. Complaint lifecycles use the shared state-machine pattern (ADR-0015); every complaint and escalation is audited (ADR-0013).

## Alternatives considered

| Option                                               | Why rejected                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Escalate unresolved complaints to Equator by default | Arbitration destroys the Ombudsman remedy; mediation can consume the 90-day window; conflict of interest (research). |
| Udofin resolves complaints itself as final authority | Grievance redressal is the lender's responsibility (research).                                                       |
| AI-only grievance desk                               | A human officer is required; AI cannot be the grievance officer (research interpretation).                           |
| Email-only complaints                                | No reliable clock, no linkage to lenders, poor evidence.                                                             |

## Consequences

**Positive**

- The borrower's statutory route stays open and visible; deadlines are computed, not left to staff.
- Evidence (timestamps, routing, replies) exists per complaint for lenders and auditors.

**Negative**

- Integration with each lender's grievance system, or a manual queue with alerts when a lender's API is down.
- Udofin must appoint and staff a nodal grievance officer.
- Equator becomes a narrower, later option than the owner first planned.

**Risks**

- A partner outside RB-IOS leaves borrowers a weaker route; this must be disclosed and weighed in lender selection.
- Mis-set clocks or missing lender data could suppress the Ombudsman notice; tests and go-live checks are needed.

## Compliance and security notes

- Supports the reported grievance, RB-IOS and arbitration-maintainability rules (labels above). Evidence (planned): complaint register with timestamps, final-reply copies with hashes, referral consent records.
- Primary-source verification gate applies (README); RB-IOS coverage and Mediation Act commencement must be confirmed.

## Verification

Planned tests (research GR-01 to GR-03, GR-21):

- A grievance raised in AI chat creates a ticket, notifies the lender the same business day, and starts the day counter.
- Closing a ticket produces a reply containing the RB-IOS link and the correct 90-day deadline.
- An Equator referral attempted on day 10 is blocked; on day 31 only a mediation option with disclosures is offered; an arbitration referral for a retail borrower is always blocked.

## Revisit triggers

- Owner decision on Equator's domain, brand and independence model.
- Primary-text review of RB-IOS 2026 coverage; Mediation Act commencement; Equator's recognition as a mediation service provider.
- A partner lender (for example an HFC) is outside RB-IOS.
