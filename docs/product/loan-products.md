# Loan products: catalogue and feasibility

Date: 2026-10-10. This document covers the nine products you listed (loan against securities,
home, vehicle, loan against property, resolution finance, medical and insurance finance, legal
expense and award enforcement finance, debt reset, payday), with personal loans shown for
reference because they are the MVP. Phasing is in [`roadmap.md`](roadmap.md) §5; decisions are in
[`open-decisions.md`](open-decisions.md).

> **Research limitation.** Regulatory statements come from `docs/research/2026-10-10/`. During
> research the sandbox could not open rbi.org.in or other primary sources (WebFetch DNS failure;
> proxy blocked HTTPS) and the shared web-search budget ran out, so findings rest on search
> snippets and secondary sources. Every regulatory paragraph reference must be verified against
> the primary RBI / UIDAI / MeitY / NPCI / SEBI text before it is relied on in a contract, policy
> or launch (D-05). Status labels: **confirmed / likely / interpretation / unverified**. Some
> product areas (insurance premium finance, litigation funding) were **not researched at all**;
> this is stated where it applies.

## 1. How products work in the platform today

- **Product categories** are platform reference data in `lending.product_categories`
  (`supabase/migrations/20261010000400_lending_core.sql`). Each has a key, a secured flag, an
  availability (`enabled`, `feasibility_review` or `not_supported`) and a minimum tenure floor.
  Every floor is at least 61 days because Google Play and Apple prohibit loan apps that require
  full repayment within 60 days (confirmed; `app-store-mobile.md` §1.4, §3). Changes need a
  reviewed migration.
- **Lender products and versions** (`lending.loan_products`, `lending.loan_product_versions`)
  hold each lender's terms: amount range, tenure range, rate type and range, and a `config` object
  (fees, eligibility rules, document checklist) validated by the API against a versioned schema.
  A version is drafted by one user and approved by another holding `product.approve`; approved
  versions are immutable; a version cannot go below its category's tenure floor; **only categories
  marked `enabled` can have versions approved**.
- Today only `personal` is `enabled`. Every other category in this document stays unavailable to
  borrowers until it passes the feasibility gates G1–G5 in [`roadmap.md`](roadmap.md) §5 and a
  reviewed migration changes its availability.

## 2. Catalogue summary

| Product                                      | Category key              | Secured | Availability today   | Tenure floor (days) | Recommended sequencing                                        |
| -------------------------------------------- | ------------------------- | ------- | -------------------- | ------------------- | ------------------------------------------------------------- |
| Personal loan (reference)                    | `personal`                | No      | `enabled`            | 91                  | MVP                                                           |
| Loan against securities: mutual funds (LAMF) | `loan_against_securities` | Yes     | `feasibility_review` | 61                  | MVP first secured product (S1), after gate review             |
| Loan against securities: shares              | `loan_against_securities` | Yes     | `feasibility_review` | 61                  | After LAMF (S1b)                                              |
| Vehicle loan                                 | `vehicle`                 | Yes     | `feasibility_review` | 180                 | First post-MVP secured product (S2)                           |
| Home loan                                    | `home`                    | Yes     | `feasibility_review` | 365                 | Later (S3), hybrid physical flow                              |
| Loan against property (LAP)                  | `loan_against_property`   | Yes     | `feasibility_review` | 365                 | Later (S3), with home loans                                   |
| Medical and insurance finance                | `medical`                 | No      | `feasibility_review` | 91                  | After Phase 08, only with institutional partners (S4)         |
| Legal expense and award enforcement finance  | `legal_expense`           | No      | `feasibility_review` | 91                  | After Phase 09, conflict review first (S5)                    |
| Resolution (settlement) finance              | `resolution_finance`      | No      | `feasibility_review` | 91                  | After Phase 09, only if the Equator conflict is resolved (S6) |
| Debt reset (consolidation)                   | `debt_reset`              | No      | `feasibility_review` | 180                 | After Phase 08, with an approved affordability model (S7)     |
| Payday / very short tenor                    | `payday`                  | No      | `not_supported`      | 61 (recorded only)  | Do not build                                                  |

## 3. The common financing engine

Every product runs through the same stages. What differs is configuration and, for some products,
a small number of controlled extensions. Three levels:

- **Standard core**: the same code for every product. Changes affect all products and go through
  the normal review.
- **Configuration**: per-lender product-version settings (in `loan_product_versions.config` and
  related lender settings). No code change; maker-checker approval by the lender; versioned.
- **Controlled extension**: product-specific code (usually a provider adapter in
  `packages/adapters` or an extra workflow step). Built only after the product's gates pass, behind
  a per-product switch, with its own spec, tests and review.

| Stage                                         | What it means                                                                                                  | Standard core                                                                                                                                                | Configuration                                                         | Controlled extensions (examples)                                                                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Purpose and beneficiary verification       | Record why the loan is taken and who receives the money.                                                       | `purpose_code` on the loan request; beneficiary is the borrower's own bank account, verified by penny drop or reverse penny drop with name match (Phase 07). | Allowed purpose codes per product.                                    | Payee routing to a specific end-use beneficiary (dealer, hospital, builder, counterparty) only with a lender exception flag and reason code; payee verification.                       |
| 2. Documents and consent                      | Collect only what the lender needs, with explicit, logged consent naming each lender.                          | Consent notices and ledger (`consent.notices`, `consent.records`); document store with hashing and versions (Phase 07); per-lender wording.                  | Document checklist per product version; lender-specific consent text. | Collateral evidence (lien confirmation, property papers), provider-specific consent (RTA OTP).                                                                                         |
| 3. Eligibility and affordability              | The lender decides creditworthiness; Udofin only applies criteria the lender has approved.                     | Lender-owned rules recorded with rule version; KYC, bureau and AA run under each lender's credentials (Phase 06).                                            | Eligibility rules, income inputs, AA purpose per product version.     | Collateral valuation input (for example NAV for LAMF), affordability model for debt reset.                                                                                             |
| 4. Offer comparison and disclosures           | Show every matching offer neutrally with the mandatory fields and a KFS link; name lenders that did not offer. | Comparison screen and display log; tenure floor; iOS APR filter (D-19); KFS per offer.                                                                       | Amount, tenure, rate, fees, penal charges per product version.        | Collateral-specific disclosures (loan-to-value, margin-call terms) supplied by the lender.                                                                                             |
| 5. Permitted disbursement routing             | The lender pays out; money goes to the borrower's verified account, with listed exceptions.                    | Disbursement evidence (date, amount, bank reference) required before `disbursed` (enforced in `servicing.loan_accounts`); no Udofin account in the flow.     | Whether the product allows an end-use exception (lender policy).      | Payee routing; staged or tranche disbursement if a lender's product needs it (feasibility question).                                                                                   |
| 6. Repayment tracking and reminders           | Show the lender's schedule and dues; let the borrower pay into the lender's account; send service reminders.   | LMS read model and schedule snapshots; payment intents and mandates in the lender's name; reminders with the lender's penal-charge text (Phase 08).          | Reminder cadence and channels per lender.                             | Display of lender margin-call notices (LAS).                                                                                                                                           |
| 7. Evidence of end use, closure or settlement | Prove the loan was used as agreed and closed cleanly.                                                          | Closure status from the LMS; NOC download.                                                                                                                   | Which closure documents the lender issues.                            | Lien release (LAS), hypothecation removal (vehicle), mortgage release (home, LAP), payoff confirmations (debt reset), provider receipts (medical), settlement completion (resolution). |
| 8. Delinquency and profitability analytics    | Understand portfolio performance without holding a competing ledger.                                           | Analytics from the lender-reported read model (Phase 10); DLG exposure if D-10 is yes.                                                                       | Lender dashboards.                                                    | Collateral-coverage views for secured products.                                                                                                                                        |
| 9. Compliance                                 | Map every regulated step to a control and evidence.                                                            | Controls matrix (`docs/regulatory/controls-matrix.md`); lender instrument mapping; DLA registry; KFS before eSign; cooling-off (Phases 04–07).               | Lender's cooling-off period, grievance contacts, stamping matrix.     | Product-specific rules (for example, no eSign for mortgage documents).                                                                                                                 |
| 10. Audit                                     | Every state change and consent is traceable and tamper-evident.                                                | `audit.events` with per-row hash and tamper detection; append-only `application_events`, `consent.records`, `payments.provider_events`.                      | None.                                                                 | Extensions log through the same audit functions.                                                                                                                                       |
| 11. Data protection                           | Keep minimal data, in India, lender-scoped and encrypted.                                                      | Minimal borrower data in Udofin's core; lender-owned artefacts in lender-scoped storage with per-lender KMS keys (Phase 06); India residency.                | Retention per lender (D-25).                                          | Extra protection and separate consent for health data (medical) and dispute data (legal expense, resolution).                                                                          |

### How each product configures the engine

| Product                           | Purpose / beneficiary                                                  | Extra evidence collected                                       | Eligibility input beyond standard                    | Disbursement routing | Closure evidence                   | Special controls                                                      |
| --------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------- | -------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| Personal                          | Borrower's own account                                                 | None                                                           | Income, employment                                   | Borrower account     | NOC                                | Standard                                                              |
| LAMF / LAS                        | Borrower's own account                                                 | Lien or pledge confirmation in the lender's favour             | Portfolio value and eligible schemes (lender's list) | Borrower account     | Lien / pledge release confirmation | Lender is lien holder / pledgee; term-loan structure for NBFCs (D-09) |
| Vehicle                           | Dealer as end-use beneficiary (lender exception)                       | Vehicle and dealer details, hypothecation evidence from lender | Vehicle value (lender)                               | Dealer account       | Hypothecation removal evidence     | Dealer verification                                                   |
| Home                              | Builder / seller as end-use beneficiary (lender exception)             | Property documents (lender-held)                               | Valuation and title (lender)                         | Builder / seller     | Mortgage release (lender)          | No eSign for mortgage documents; physical/registered execution        |
| LAP                               | Typically borrower's account (lender policy)                           | Property documents (lender-held)                               | Valuation and title (lender)                         | Per lender policy    | Mortgage release (lender)          | As home                                                               |
| Medical / insurance               | Hospital or insurer as end-use beneficiary (lender exception)          | Estimate or invoice from the provider                          | Standard                                             | Provider account     | Provider receipt                   | Health data minimised and lender-scoped                               |
| Legal expense / award enforcement | Per lender policy (feasibility question)                               | Matter details (minimal)                                       | Standard                                             | Per lender policy    | Per lender policy                  | Equator conflict controls                                             |
| Resolution finance                | Counterparty or award-holder as end-use beneficiary (lender exception) | Settlement or award document                                   | Standard                                             | Counterparty         | Settlement completion              | Equator conflict controls                                             |
| Debt reset                        | Existing lenders (feasibility question)                                | Statements of the debts being repaid                           | Affordability model                                  | Per counsel's view   | Payoff confirmations / NOCs        | No evergreening; no marketing to accounts in collections              |

---

## 4. Product details

### 4.1 Loan against securities (shares and mutual funds)

- **Category.** `loan_against_securities`; secured; `feasibility_review`; floor 61 days.
- **Who must do what.**
  - _Lender:_ credit decision; acts as **pledgee** (demat securities, through its depository
    participant with NSDL or CDSL) or **lien holder** (mutual-fund units in statement form, through
    the RTAs CAMS and KFintech or MF Central); loan-to-value policy, margin calls, invocation and
    sale; onboarding with RTAs and depositories (likely; `providers-payments.md` §10).
  - _Udofin:_ technology service provider: portfolio fetch, scheme selection, OTP lien or pledge
    journey, display of lender terms, lien-release prompt at closure. Never pledgee or lien holder.
  - _Borrower:_ authorises the lien or pledge (competitors use an OTP to the folio-registered
    mobile; lien marking reported at about 10 minutes — vendor claim, `competitors-ux.md` §3).
- **Key constraints.**
  - Only the lender can be pledgee or lien holder (likely). Pledge of demat securities is executed
    through the depository, not by eSign (likely).
  - Loan-to-value limits belong to the lender's credit policy; research cites 50% for NBFC lending
    against listed shares as an example (unverified).
  - SEBI's 2020 margin-pledge regime is for stock-broker margins, not lender pledges (likely).
  - Many competitor LAMF products are credit lines, but an Aug 2026 RBI draft would limit most
    NBFCs to term loans (draft) and DLG cannot cover revolving credit (confirmed, secondary). Hence
    D-09.
  - Play treats LAS as a personal loan (interpretation), so store rules apply; tenure above 60
    days.
- **Main integrations.** RTA lien services (CAMS, KFintech, MF Central) and depository pledge
  (NSDL, CDSL) through the lender; lender's NAV or price feed; eSign; mandate; LMS.
- **Core / configuration / extensions.** Core: request, offers, KFS, eSign, servicing.
  Configuration: eligible schemes, loan-to-value, amount, tenure, rate, margin thresholds (all
  lender-owned). Extensions: portfolio-fetch and lien/pledge adapter; lien-release workflow;
  collateral value display from the lender's feed.
- **Feasibility questions.** Which launch lenders are already onboarded as lien holder or pledgee?
  Term loan or credit line (D-09)? Who pays RTA and depository charges? Where does the NAV or
  price feed come from, and how are margin calls communicated? How are partial release and
  invocation handled? Can the lender's KYC reuse investor KYC?
- **Recommended sequencing.** Mutual funds in statement form first (MVP, S1), shares and demat
  units later (S1b). Competitor evidence: Groww launched LAMF on 6 Oct 2025 and CRED Cash+ in Feb
  2025 (verified via extracts and secondary sources; `competitors-ux.md` §3).

### 4.2 Home loan

- **Category.** `home`; secured; `feasibility_review`; floor 365 days.
- **Who must do what.** _Lender:_ credit, valuation, title and legal checks, mortgage creation and
  registration, registration of the security interest (CERSAI is named in research as relevant
  security-registration law; likely), disbursement to builder or seller. _Udofin:_ request,
  document collection orchestration, status tracking, KFS display, appointment scheduling for
  physical steps. _Borrower:_ physical or registered execution of mortgage documents.
- **Key constraints.**
  - Contracts for sale or conveyance of immovable property and powers of attorney cannot be
    executed by eSign (likely; IT Act First Schedule; `providers-payments.md` §2); the database
    note on this category says the same.
  - Disbursement to a builder or seller relies on the specific end-use exception (confirmed,
    secondary; `rbi-digital-lending.md` §3.3).
  - Stamp duty is state-specific (likely).
  - Play: home loans are arguably fixed-asset financing outside Play's personal-loan definition
    (interpretation), but the app as a whole remains a personal-loan app.
  - Housing finance companies may fall outside the RBI Integrated Ombudsman Scheme 2026 (reported
    in one research note, unverified in another), which changes the escalation route shown.
- **Main integrations.** Lender LOS; lender's valuation and legal vendors; document upload; eStamp;
  physical execution scheduling; lender-side data via RBIH's Unified Lending Interface (land
  records) where the lender uses it (interpretation; `competitors-ux.md` §5).
- **Core / configuration / extensions.** Core: request, offers, KFS, servicing. Configuration:
  document checklist, terms. Extensions: hybrid physical/registration workflow states; payee
  routing to builder or seller.
- **Feasibility questions.** Which lenders (NBFC or HFC) and their grievance escalation route?
  How much of the journey can be digital? Construction-linked tranche disbursement? Who schedules
  and evidences physical execution?
- **Recommended sequencing.** S3, after vehicle loans. Competitor research places LAP and home
  loans at 12+ months.

### 4.3 Vehicle loan

- **Category.** `vehicle`; secured; `feasibility_review`; floor 180 days.
- **Who must do what.** _Lender:_ credit, hypothecation registration (database note), dealer
  onboarding, disbursement to the dealer, insurance requirements. _Udofin:_ request, dealer and
  vehicle details capture, offers, KFS, eSign of the loan agreement, servicing, closure evidence.
- **Key constraints.**
  - Disbursement to the dealer relies on the specific end-use exception (confirmed, secondary).
  - Stamping of loan and hypothecation instruments is state-specific (likely).
  - RBIH reports a ULI pilot with 6 lenders, live 1 Mar 2026, for vehicle-hypothecation
    termination with MoRTH (confirmed, primary via extract; `competitors-ux.md` §5). This is
    lender-side infrastructure.
  - Play: arguably fixed-asset financing (interpretation).
- **Main integrations.** Dealer payee details (lender), vehicle data via the lender, eSign, eStamp,
  mandate, LMS.
- **Core / configuration / extensions.** Core: standard journey. Configuration: terms, document
  checklist. Extensions: dealer payee routing; hypothecation and removal evidence.
- **Feasibility questions.** New, used or two-wheeler first? Dealer network and verification? Who
  confirms delivery and registration? How is hypothecation removal evidenced at closure?
- **Recommended sequencing.** S2, the first secured product after LAMF; competitor research places
  vehicle loans at 6–12 months.

### 4.4 Loan against property (LAP)

- **Category.** `loan_against_property`; secured; `feasibility_review`; floor 365 days.
- **Who must do what.** As for home loans: the lender handles valuation, title, mortgage creation
  and registration of the security interest; Udofin orchestrates the request, documents and status.
- **Key constraints.** No eSign for mortgage documents (likely). Play treats LAP as a personal loan
  (interpretation). Stamp duty is state-specific (likely).
- **Main integrations.** As home loans.
- **Core / configuration / extensions.** As home loans; disbursement normally to the borrower's
  account under lender policy.
- **Feasibility questions.** End-use restrictions set by the lender? Property types accepted?
  Physical execution logistics?
- **Recommended sequencing.** S3, with home loans.

### 4.5 Resolution (settlement) finance

- **Category.** `resolution_finance`; unsecured; `feasibility_review`; floor 91 days. Database
  note: the conflict of interest with an affiliated ADR platform must be resolved before launch.
- **Who must do what.** _Lender:_ independent credit decision; disbursement to the counterparty or
  award-holder named in the agreement (end-use exception). _Udofin:_ request, offers, KFS,
  servicing. _Equator:_ none in the credit or marketing process.
- **Key constraints.**
  - Financing the outcome of disputes heard on a group-affiliated platform creates incentive and
    tying conflicts (interpretation; `grievance-adr-collections.md` challenge 7;
    `ecosystem-sites.md` §6.3). Research recommends keeping these products away from Equator
    matters involving Udofin-sourced loans, independent lender decisions, conflict disclosure, no
    use of Equator data for credit or marketing, and no solicitation of Equator parties.
  - Enforceability of mediated settlements depends on the Mediation Act 2023 commencement status,
    which is unverified as at October 2026.
- **Main integrations.** Settlement or award document intake; payee routing; standard servicing.
- **Core / configuration / extensions.** Extensions: counterparty payee routing; settlement
  completion evidence.
- **Feasibility questions.** Which dispute types? How is the settlement verified? What if the
  settlement concerns a loan from a partner lender (overlap with debt reset and evergreening)?
- **Recommended sequencing.** S6, only after D-17 and a legal opinion; consider excluding all
  Equator-linked matters.

### 4.6 Medical and insurance finance

- **Category.** `medical`; unsecured; `feasibility_review`; floor 91 days. Database note: requires
  institutional partnerships and end-use routing to providers.
- **Who must do what.** _Lender:_ credit; disbursement to the hospital or insurer as end-use
  beneficiary. _Hospital / insurer:_ estimate or invoice, confirmation of receipt. _Udofin:_
  request, offers, KFS, payee routing, servicing.
- **Key constraints.**
  - Disbursement to a hospital relies on the specific end-use exception (likely; named as an
    example in `providers-payments.md` §6).
  - Health information is high-sensitivity (interpretation); collect only what the lender needs and
    keep it lender-scoped.
  - **Insurance premium finance and any IRDAI rules were not researched**; counsel must advise
    before scoping.
  - Play treats it as a personal loan (interpretation).
- **Main integrations.** Provider (hospital, insurer) onboarding and payee verification;
  standard rails.
- **Core / configuration / extensions.** Extensions: provider payee routing; provider receipt
  evidence.
- **Feasibility questions.** Which hospitals or insurers? Timing of disbursement (pre-authorisation
  or discharge)? Refunds if treatment is cancelled? Interaction with insurance claims?
- **Recommended sequencing.** S4, after Phase 08 and only with signed institutional partners.

### 4.7 Legal expense and award enforcement finance

- **Category.** `legal_expense`; unsecured; `feasibility_review`; floor 91 days. Database note:
  ordinary repayable loans only; non-recourse funding is out of scope.
- **Who must do what.** _Lender:_ credit; payout per its policy. _Udofin:_ request, offers, KFS,
  servicing.
- **Key constraints.**
  - Same Equator conflict concerns as resolution finance. Research suggests considering dropping
    award-enforcement finance where Equator issued the award (`ecosystem-sites.md` §6.3).
  - **Rules on funding litigation (for example outcome-linked funding or payments to advocates)
    were not researched**; counsel must advise.
- **Main integrations.** Standard rails; optional payee routing if the lender's policy allows.
- **Core / configuration / extensions.** Mostly core and configuration; extension only for payee
  routing.
- **Feasibility questions.** Who is the payee? How is end use evidenced? How are Equator-linked
  matters excluded?
- **Recommended sequencing.** S5, after Phase 09 and D-17.

### 4.8 Debt reset (consolidation)

- **Category.** `debt_reset`; unsecured; `feasibility_review`; floor 180 days. Database note: needs
  an approved affordability model; lenders must not evergreen stressed accounts.
- **Who must do what.** _Lender:_ affordability assessment and credit decision; payoff of existing
  debts. _Udofin:_ request, statements upload, offers, KFS, payoff tracking, servicing.
- **Key constraints.**
  - Research recommends careful suitability and fair-practice design (`competitors-ux.md` §9) and
    no marketing of "debt reset" to accounts in active collections without lender approval
    (`grievance-adr-collections.md` challenge 8).
  - Whether paying other lenders directly fits the end-use exception is an interpretation for
    counsel.
  - Each lender reports its loans to credit bureaus weekly from 1 Jul 2026 (confirmed, secondary).
- **Main integrations.** Statement intake (or AA under the lender's FIU); payoff confirmations;
  standard rails.
- **Core / configuration / extensions.** Extensions: affordability model input; payoff routing
  and confirmation tracking.
- **Feasibility questions.** Who owns and validates the affordability model? How are payoffs
  confirmed (closure letters or NOCs from old lenders)? How is refinancing of the same lender's
  stressed loans prevented?
- **Recommended sequencing.** S7, after Phase 08.

### 4.9 Payday / very short-tenor loans

- **Category.** `payday`; unsecured; `not_supported`.
- **Why not supported.**
  - Google Play prohibits apps promoting personal loans that require full repayment in 60 days or
    less; Apple prohibits the same and caps APR at 36% including fees (confirmed;
    `app-store-mobile.md` §1.4, §3). Offering it risks removal of the whole app.
  - An Aug 2026 RBI draft proposes an APR cap on small-value loans up to ₹50,000 (draft; cap level
    unverified; `rbi-digital-lending.md` §4).
  - RBI's June 2026 Financial Stability Report flagged rising delinquency in fintech small-ticket
    personal loans (figures secondary).
- **Recommendation.** Do not build (D-23). If a small-ticket product is needed, offer it as a
  personal loan with tenure above 90 days (category floor 91) and transparent APR.

## 5. Recommended sequence

1. Personal loans (MVP, Android).
2. LAMF in statement form (MVP, gate S1).
3. Vehicle (S2) and LAS on shares (S1b).
4. Medical with institutional partners (S4) and debt reset with an approved affordability model
   (S7).
5. LAP and home loans with hybrid physical flows (S3).
6. Legal expense (S5) and resolution finance (S6), only after the Equator independence model and a
   legal opinion.
7. Payday: not supported.
