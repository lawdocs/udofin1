# ADR-0020: Product scope, tenure floors and the payday exclusion

- **Status:** Accepted (baseline, pending owner approval) — the category catalogue and tenure floors are in the database; the iOS APR filter is planned; the first secured product is an open owner decision
- **Date:** 2026-10-10
- **Related:** ADR-0006, ADR-0009, ADR-0015, ADR-0016, ADR-0022

## Context

Research findings:

- **Google Play** prohibits apps promoting personal loans that require full repayment in 60 days or less (confirmed, `docs/research/2026-10-10/app-store-mobile.md`, `rbi-digital-lending.md` §4).
- **Apple guideline 3.2.2(ix)** (guidelines last updated 8 Jun 2026): loan apps may not charge a maximum APR above 36% including costs and fees, and may not require repayment in full in 60 days or less; applies worldwide (confirmed, fetched). **Contradiction to resolve:** live Indian App Store listings show higher APR ranges (CRED 9.5%–45%, Groww 13%–48%; `competitors-ux.md`). Verify how Apple applies the cap in India before relying on either reading.
- RBI has no separate payday category or minimum tenor (research statement). A draft of 12 Aug 2026 would cap APR on loans of ₹50,000 or less; the cap level and finalisation are **unverified**. A draft of Aug 2026 would limit most NBFCs to term loans (likely; final not found).
- Mortgage documents cannot be executed by eSign (IT Act First Schedule exclusions, likely); the lender (not Udofin) registers security interests with CERSAI within 30 days (likely) (`privacy-security-outsourcing.md` §8, `providers-payments.md` §2).
- Loan against securities: the pledge or lien must be in favour of the lender as pledgee/lien holder via depositories or RTAs (likely, `providers-payments.md` §10). Competitor research shows loans against mutual funds launched by several large apps in 2025 (`competitors-ux.md`).
- Aadhaar OTP e-KYC accounts are limited to aggregate term loans of ₹60,000 a year until full due diligence (likely, `kyc-aadhaar-bureau.md` KYC-03).

## Decision

1. **Platform category catalogue** (`lending.product_categories`, changed only by reviewed migration). Each category has an availability and a minimum tenure floor; every floor is at least 61 days:

| Category                | Secured | Availability       | Min tenure (days) |
| ----------------------- | ------- | ------------------ | ----------------- |
| personal                | no      | enabled            | 91                |
| loan_against_securities | yes     | feasibility_review | 61                |
| vehicle                 | yes     | feasibility_review | 180               |
| home                    | yes     | feasibility_review | 365               |
| loan_against_property   | yes     | feasibility_review | 365               |
| medical                 | no      | feasibility_review | 91                |
| legal_expense           | no      | feasibility_review | 91                |
| resolution_finance      | no      | feasibility_review | 91                |
| debt_reset              | no      | feasibility_review | 180               |
| payday                  | no      | **not_supported**  | 61                |

2. **MVP:** unsecured personal loans with tenure above 90 days from 2–4 lenders. **First secured product candidate:** loan against mutual funds/securities, with the lender as pledgee or lien holder and Udofin orchestrating only; the choice versus vehicle loans is an owner decision.
3. **Later:** home, LAP and vehicle (physical or registered execution for mortgages; hypothecation and CERSAI by the lender). Medical, legal-expense, resolution finance and debt reset each need a separate feasibility assessment (resolution finance has a conflict with the affiliated ADR platform; debt reset needs an approved affordability model).
4. **Payday is not supported** on any channel, including web (the web is not a route around store rules; research interpretation).
5. Only `enabled` categories can have an approved product version; a version can never go below its category's tenure floor (database trigger; ADR-0006).
6. **Term loans only** through NBFC partners until the revolving-credit draft is resolved.
7. **iOS:** offers whose all-in APR (KFS method) exceeds 36% are not shown in the iOS app (planned), pending resolution of the contradiction above.

## Alternatives considered

| Option                                   | Why rejected                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offer payday loans                       | Barred by both stores; draft APR cap on small loans; rising delinquency flagged by RBI's June 2026 FSR (secondary).                                                 |
| Split payday into 61-day tenors          | Clears the 60-day line on paper but likely breaches Apple's APR cap and invites circumvention enforcement on the whole developer account (research interpretation). |
| Launch many categories at once           | Each needs lender capabilities, documents and legal work (pledge, mortgage, end-use routing); delays the MVP.                                                       |
| Let each lender define categories freely | Platform-level rules (tenure floors, payday ban) must hold across lenders.                                                                                          |

## Consequences

**Positive**

- Store-policy limits are enforced in the database for every lender configuration.
- Scope is clear for lenders and for the team.

**Negative**

- Some lenders' existing short-tenor products cannot be offered.
- The iOS APR filter may hide offers that Android and web show, creating channel differences to explain.

**Risks and known gaps (baseline)**

- Floors are checked on product versions only. `loan_requests.requested_tenure_days` allows 1 day upward, and `lending.offers` is not validated against the pinned version's amount, tenure or rate bounds or the category floor. An offer below the floor would not be refused by the database today.
- `offers.apr_bps` allows up to 200%; the 36% iOS rule is not encoded yet.

## Compliance and security notes

- Supports Play and Apple loan-app rules (confirmed) and tracks RBI drafts (unverified/likely). Evidence: migration history of `product_categories`; product version approvals; offer-filter logs (planned).
- Primary-source verification gate applies (README); the Apple APR contradiction must be resolved before iOS launch.

## Verification

- `supabase/tests/003_lifecycle_and_integrity.test.sql`: a lender cannot configure a personal loan below the platform's minimum tenure.
- Planned (research MS-04, MS-05, DL-34): the API rejects a mobile offer with tenure of 60 days or less; a seeded offer at 36.01% APR is hidden on iOS; offers outside the product version's bounds are rejected.

## Revisit triggers

- Owner decision on the first secured product; feasibility results for other categories.
- Final RBI interest-rate directions (APR cap level) or revolving-credit rule.
- Clarification of Apple's APR cap as applied in India.
