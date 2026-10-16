# ADR-0014: Consent ledger — versioned notices and append-only decisions

- **Status:** Accepted (baseline, pending owner approval)
- **Date:** 2026-10-10
- **Related:** ADR-0009, ADR-0013, ADR-0018, ADR-0022, ADR-0024

## Context

Research findings (labels as in the notes):

- Digital lending: collect only needed data, with prior explicit consent and an audit trail; borrowers can refuse particular data, revoke consent and ask for deletion; purpose limitation applies (confirmed (secondary), `docs/research/2026-10-10/rbi-digital-lending.md` DL-12).
- RBC (Second Amendment) Directions of 15 Jun 2026, effective 1 Jan 2027: explicit marketing consent separately for each product, no forced bundling, no dark patterns (confirmed (secondary), DL-30).
- Purpose-specific consent per rail and per lender: Aadhaar authentication and offline verification, DigiLocker pull, CKYC download OTP, each lender's bureau pull (likely, `kyc-aadhaar-bureau.md` DATA-04).
- DPDP Act 2023 and DPDP Rules 2025 notified 13/14 Nov 2025; notice, consent and rights obligations from about 13/14 May 2027; a consultation on shortening this to 12 months was not confirmed as adopted (confirmed (secondary) / unverified, `privacy-security-outsourcing.md`). Consent-manager registration about Nov 2026, date not settled; consent managers keep records 7 years (confirmed, secondary).
- Apple guideline 5.1.1(viii): apps may not compile personal information from sources other than the user without explicit consent (confirmed, `app-store-mobile.md`).
- Sharing data with a group company (Equator) needs separate consent; loan consent cannot be bundled with marketing, "books of accounts" analytics or an Equator referral (interpretation, `privacy-security-outsourcing.md`).

## Decision

1. **Notices** (`consent.notices`) hold the exact text shown: purpose key, version, language, optional lender (lender-specific wording), title, body, data categories and retention summary. A trigger stores the SHA-256 of the body. Once published, a notice is immutable; only `draft → published → retired` is allowed; publishing requires `published_at` and `approved_by`; published notices cannot be deleted.
2. **Records** (`consent.records`) are an **append-only ledger**: borrower, notice (must be published), lender (when the purpose is lender-specific), decision (`granted`, `denied`, `withdrawn`), channel (`mobile_app`, `web`, `assisted`), time, app version, evidence (screen id, request id — never identity numbers), and `captured_by` for assisted journeys.
3. **Withdrawal is a new record**, never an edit. `consent.current_decisions` (security-invoker view) returns the latest decision per borrower, purpose and lender.
4. **Granularity:** one purpose per notice, and per lender where the processing is for a lender. Separate purposes for sharing a request with lenders, each KYC rail, each lender's bureau pull, marketing (per product), and any Equator referral. No bundling, no pre-ticked boxes.
5. **Enforcement point:** the API checks `current_decisions` before each processing step and passes the authorising record id to providers (`ProviderCallContext.consentRecordId` in `packages/adapters/src/provider.ts`). Refusing marketing never blocks a loan application or servicing.
6. **Access:** borrowers insert and read only their own records and cannot use the `assisted` channel (assisted capture is a staff workflow through the API); lenders read consents granted to them; draft notices are visible only to holders of `platform.consent_notices.manage`.
7. A registered DPDP consent manager is not used for now; revisit when the rules commence.

## Alternatives considered

| Option                                    | Why rejected                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Boolean consent flags on the borrower row | Loses history, wording and evidence; withdrawal overwrites the grant.                              |
| Consent only in application logs          | Mutable, hard to prove, not queryable per lender.                                                  |
| Screenshots of each screen as evidence    | Heavy and contain personal data; hashed versioned wording plus app version is lighter and precise. |
| Third-party consent manager now           | Registration regime not yet in force and its date unsettled (research).                            |

## Consequences

**Positive**

- For any processing step, Udofin can show which exact words the borrower agreed to, when, on which channel and app version, and whether that is still current.
- Lenders can audit consents given to them without seeing others'.

**Negative**

- Many notices to draft, translate, version and approve; each wording change needs a new version and fresh consent where material.
- Every processing step must call the consent check; missing one is a defect the database cannot catch.

**Risks and known gaps (baseline)**

- The database does not enforce that processing checked consent; this is an API rule (planned).
- Notice publication has no database maker-checker (no drafter column; ADR-0006).
- `purpose` is a free-text key (pattern-checked); there is no purpose catalogue table yet.
- `evidence` is free-form JSON; the API must validate it so no personal data enters.
- `lender_org_id` on notices and records is not checked to be a lender organisation.
- Retention period for consent records is not yet decided (research notes 7 years for consent managers; Udofin's own period is open).

## Compliance and security notes

- Supports the reported consent, audit-trail and purpose-limitation rules (labels above). Evidence: notice versions with hashes, the append-only ledger, the current-decisions view.
- DPDP notice content and the RBC Second Amendment details must be checked against primary texts before notices are finalised (primary-source verification gate, README).

## Verification

- `supabase/tests/003_lifecycle_and_integrity.test.sql`: published consent wording can never change; consent records cannot be deleted; withdrawal is a new record and becomes the current decision.
- `supabase/tests/002_tenant_isolation.test.sql`: a lender officer sees only consents granted to that lender; each borrower sees only their own records.
- Planned (research DL-12, DL-30): revoking consent for a lender stops further sharing with it; declining marketing does not block an application; no consent box is pre-ticked (design review).

## Revisit triggers

- DPDP substantive rules commence (or the 12-month cut is notified).
- Consent-manager or Account Aggregator flows are introduced.
- Primary-text review of the RBC Second Amendment (effective 1 Jan 2027).
