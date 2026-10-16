# ADR-0024: Boundaries between Udofin, Finbyx, LawDocsComply and Equator

- **Status:** Proposed — event naming for the four products exists in `packages/contracts`; integrations, SSO and data-sharing flows are not built
- **Date:** 2026-10-10
- **Related:** ADR-0007, ADR-0009, ADR-0012, ADR-0014, ADR-0018

## Context

- The group runs four products: **Udofin** (LSP platform), **Finbyx** (LOS/LMS for lenders), **LawDocsComply** (compliance obligations and evidence), and **Equator** (ADR/ODR platform; the public platform appears to be Equa.Law, likely; `docs/research/2026-10-10/ecosystem-sites.md` §4).
- Each processes data for different purposes and roles. A group-wide "single customer view" or shared data lake would breach purpose limitation and the LSP minimal-data rule (likely, `ecosystem-sites.md` §6).
- Conflicts of interest (interpretation unless marked): partner lenders may use Finbyx and LawDocsComply while overseeing Udofin, so group tools could hold lenders' oversight records about Udofin; Equator is affiliated with Udofin (ADR-0018).
- Finbyx's Supabase project is in Tokyo (confirmed; ADR-0010).

## Decision

1. **Separate products:** separate databases, deployments, repositories and release cycles. **No shared tables** and no cross-product database access.
2. **Integration only through explicit APIs and signed events** using the CloudEvents envelope and `in.<product>.<aggregate>.<fact>.v<major>` naming (ADR-0012). Each product validates what it receives.
3. **Data ownership:**

| Record                                   | Owner / system of record                                                  | What others receive                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Borrower account                         | Udofin                                                                    | Others: nothing by default                                          |
| Loan record                              | The lender, in its LMS (Finbyx acts as the lender's processor where used) | Udofin: immutable read model (ADR-0007)                             |
| Complaint                                | The lender (authoritative); Udofin keeps a linked ticket                  | LawDocsComply: aggregates such as SLA breaches and counts           |
| Compliance obligation, control, evidence | LawDocsComply, one tenant per legal entity, no borrower personal data     | Evidence events with ids and metrics only                           |
| Dispute case                             | Equator, as an independent fiduciary                                      | Udofin/lender: only the outcome status the parties consent to share |

4. **Equator referrals** use a consent token: the borrower's separate, explicit, post-dispute consent (ADR-0014, ADR-0018) authorises a defined data set to be sent; nothing else flows.
5. **Staff SSO** across products is allowed with **segregation-of-duties rules**: no individual holds Udofin collections or operations roles and Equator case-administration or neutral roles at the same time.
6. **No group-level shared customer view** or cross-product analytics on personal data.
7. Conflicts of interest are disclosed to lenders and borrowers where relevant (Finbyx/LawDocsComply serving lenders who oversee Udofin; Equator affiliation).

## Alternatives considered

| Option                                           | Why rejected                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| One shared database or data lake for the group   | Breaches purpose limitation and LSP minimal-data rules; one breach exposes all products; blurs fiduciary roles. |
| Shared tables with row-level filters per product | Same problems, and couples release cycles.                                                                      |
| Merge Finbyx into Udofin                         | Udofin would hold lenders' loan accounting (ADR-0007).                                                          |

## Consequences

**Positive**

- Clear fiduciary and processor roles per product for lender due diligence and DPDP.
- One product's incident does not expose the others' data.

**Negative**

- Integration work (APIs, events, SSO rules) and duplicated reference data.
- Group reporting needs aggregate, de-identified feeds.

**Risks**

- Informal shortcuts (shared credentials, database links, exports) between products. Mitigation: access reviews and the event-only integration rule.
- Finbyx residency issue until it moves to Mumbai (ADR-0010).

## Compliance and security notes

- Supports the reported purpose-limitation and minimal-data rules (likely) and arbitrator/mediator independence concerns (likely). Primary-source verification gate applies (README).

## Verification

- `packages/contracts/src/events/envelope.ts` restricts event products to `udofin`, `finbyx`, `lawdocscomply`, `equator`; `envelope.test.ts` validates envelopes.
- Planned: quarterly access review checking the segregation-of-duties rule (research EC-15); a review that no product holds credentials to another product's database; a test that an Equator referral without a consent token is refused.

## Revisit triggers

- Owner decisions on Equator's domain, brand and independence model; Finbyx migration to Mumbai.
- Any proposal for shared customer data across products.
- A change in the legal entities that run each product.
