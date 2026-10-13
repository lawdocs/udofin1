# Phase 05 specification and implementation record: borrower onboarding and loan request

**Status:** implemented on the feature branch (PR 1) on 13 Oct 2026 after the owner's Phase 05 brief; awaiting owner review. Nothing is deployed, nothing has been run on a device, and no regulatory compliance or production readiness is claimed.
**Replaces** the draft v1 of this spec. **Depends on:** Phases 01–04. **Decisions:** D-14, D-15, D-24 decided; D-25 partly; D-34 to D-38 open (`../product/open-decisions.md`).

## 1. Objective in plain English

A borrower signs in with a mobile number and a one-time code, optionally gives a name to be addressed by, picks English or Hindi, gives separate consents, and sends a loan request (category, amount, period, purpose). They can save a draft (it closes 30 days after it was created), see their requests and history, change communication preferences and ask to delete their account. Udofin keeps only a display name, language and message preferences. No PAN, Aadhaar, date of birth, bank details, KYC or credit data is collected; age and eligibility are for the lender in Phase 06. A request is not an application result: nothing is scored, matched, approved or offered.

## 2. Corrections to the draft

- The draft (Q7) said a fixed loan-purpose list "exists". No such list exists in the repository or earlier specs. That statement is withdrawn. The purpose table and API ship empty and refuse requests until the owner supplies the list (D-34).
- The draft named D-26 as the SMS provider choice; D-26 is the ecosystem-boundaries decision. The provider and DLT question is now D-35.
- The draft's trust page, grievance-contact activation condition, staff notice-publishing screens, SMS Retriever app hash and Phone Number Hint, and the "four interactions" target are **not** in the Phase 05 brief and were not built (section 8).

## 3. What was built

| Area     | Built                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database | `20261014000790_borrower_onboarding.sql`, `…791_borrower_helpers.sql`: profile columns and onboarding states; communication preferences; consent evidence function; `lending.loan_purposes`; loan-request columns, submission trigger, events and a view that shows overdue drafts as expired; step-up, integrity, attestation and deletion tables and functions; grants; audit |
| API      | `services/api/src/modules/borrower`: profile, consent, reference data, loan requests, step-up, integrity, deletion, signed Send SMS hook; `docs/api/borrower.md`                                                                                                                                                                                                                |
| Worker   | `borrower.deletion_requested` handler, draft-expiry housekeeping every 15 minutes                                                                                                                                                                                                                                                                                               |
| Ports    | `SmsSender` (+ timeout wrapper, unconfigured and labelled mock) and `IntegrityVerifier` (+ unavailable and labelled mock); mocks refused in staging and production                                                                                                                                                                                                              |
| Mobile   | Sign-in and code screens (localised), home, profile, consents, request wizard, my requests and detail with history and expiry warnings, settings, two-step account deletion, step-up screen; English and Hindi; form held above translated screens                                                                                                                              |
| Shared   | Contracts in `packages/contracts/src/http/borrower.ts`; generic API client allow-list extended to borrower paths                                                                                                                                                                                                                                                                |

## 4. Design points

1. **Rules in the database, repeated in the API.** See ADR 0029.
2. **Journey facts are separate:** account created, profile started, profile completed, consents completed, drafts, submitted. KYC and eligibility are always "not started" and "not assessed".
3. **Consent:** one row per decision with notice id, version, hash, language, channel, screen, app version; withdrawal is an event; marketing cannot be recorded while disabled; the three required consents are terms, privacy notice and sharing with lenders.
4. **Loan request:** states `draft`, `submitted`, `offer_selected`, `withdrawn`, `expired`, `closed`; product reference and snapshot only when a borrower-visible product is chosen; optimistic concurrency by `expectedVersion`; submission idempotent with reference `UR-` plus 10 hex characters.
5. **Step-up and integrity** are separate (D-24). The step-up code is hashed, bound to action and object, single use, five tries, five minutes, with a daily budget of two locked challenges. Integrity levels come from the server's verifier only.
6. **Deletion** anonymises and keeps consent and audit records; the phone identity in the auth provider is pending (D-38).
7. **Language:** the choice is stored on the device and on the account; once the account holds a preference it wins on every device; switching never resets a form.
8. **Product discovery** reads only `lending.borrower_visible_product_versions`.

## 5. Acceptance criteria and result

| #   | Criterion (from the Phase 05 brief and the draft)                                        | Result                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Account/profile states are separate and never mean verified or eligible                  | Met in database and API (tests)                                                                                                                                                |
| 2   | Consents separate, unticked, recorded against exact wording; withdrawal is an event      | Met in database/API (tests). No notice text exists yet (D-37). The mobile screen leaves every box unticked (by review, not by a UI test)                                       |
| 3   | Marketing off; ledger ready                                                              | Met (tests)                                                                                                                                                                    |
| 4   | English and Hindi everywhere; preference persisted; form survives a language switch      | Catalogues, parity test and reducer test pass. Hindi text is a draft awaiting review. Not tried on a device                                                                    |
| 5   | Request cannot be submitted after expiry, without consents, with unknown purpose         | Met (pgTAP and HTTP tests). Purpose list empty until D-34                                                                                                                      |
| 6   | Drafts expire 30 days after creation, not extended; enforced on read and write           | Met (tests)                                                                                                                                                                    |
| 7   | Duplicate/concurrent submission safe                                                     | Met for repeated and replayed submits (tests); a true parallel race is covered by the database lock and idempotency design but has no dedicated concurrency test in this phase |
| 8   | Step-up OTP bound, hashed, limited; integrity distinct; client claims not trusted        | Met (tests). No sensitive action calls it yet                                                                                                                                  |
| 9   | SMS port; no provider; no live SMS; no hard-coded DLT values; acceptance is not delivery | Met. Real delivery is untested because no provider exists                                                                                                                      |
| 10  | Account deletion safe, auditable, retry-safe; no invented retention                      | Met (tests); sign-in identity removal pending (D-38)                                                                                                                           |
| 11  | Cross-borrower and staff isolation                                                       | Met (pgTAP, HTTP tests, independent static review)                                                                                                                             |
| 12  | Mocks cannot run in staging or production                                                | Met (config and adapter checks, tests)                                                                                                                                         |
| 13  | Mobile screens with loading, error, retry and empty states, accessibility labels         | Built; the Android bundle compiles; **not rendered, not run on a device, no screen-reader test**                                                                               |
| 14  | Manifest has no SMS, contacts, phone, storage or media permission                        | `pnpm --filter @udofin/mobile config:check` passes (29 permissions blocked, none declared); the merged manifest of a built app was not inspected                               |

## 6. Out of scope (not built)

KYC, PAN, Aadhaar, date of birth, bureau, scoring, underwriting, eligibility, sanction, disbursement, e-sign provider, bank verification, mandates, marketing messages, new products or terms, lender matching and offers (Phase 06), the trust page and grievance contacts, staff notice-publishing screens, SMS Retriever and Phone Number Hint, a production SMS provider and a production device-integrity verifier.

## 7. Open items

D-34 purpose list; D-35 SMS provider and DLT; D-36 tenure convention; D-37 consent and Hindi approval; D-38 sign-in identity removal; D-25 retention schedule; D-08 app identity and Play Integrity; open security items in `../security/review-2026-10-13-phase05.md`.

## 8. Risks

SMS delivery and DLT registration may block launch. Hindi borrowers must use approved English consent text until Hindi is approved. The 2027 per-product consent rules may change the consent screen. The app wizard takes more than four taps; whether that is acceptable needs user testing. Mobile screens are untested on devices.
