# Phase 05 specification: borrower onboarding and loan request

**Status:** draft v1 for owner approval (13 Oct 2026). Nothing in this phase is implemented.
**Depends on:** Phases 01–04 (all on PR 1). **Roadmap:** `docs/product/roadmap.md`, Phase 05.
**Decisions this spec needs from you:** D-14 (marketing), D-15 (languages), D-24 (device integrity), and the questions in section 10.

## 1. Objective in plain English

A borrower opens the app, enters a mobile number, gets an SMS code (filled in automatically on Android), reads and accepts a few separate consents, says what they need (category, amount, tenure, purpose) and submits a **loan request**, in four or five deliberate taps. If they close the app they come back to exactly where they stopped. Udofin keeps only name and contact details at this stage. No PAN, Aadhaar, date of birth, documents, KYC or credit data is collected or stored; that begins in Phase 06 and belongs to the lender.

The request is **not** an application to a lender and nothing is shown, scored or decided yet. Matching to lenders and offers is Phase 06.

## 2. What exists already (not rebuilt)

| Area                                                                                                                                                               | State                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Mobile phone sign-in screens, secure session storage, guarded routes                                                                                               | Built in Phase 03 against Supabase Auth; real SMS not connected |
| `identity.borrowers` (no identifiers), `consent.notices` (versioned, hashed, approved) and `consent.records` (append-only), `lending.loan_requests` with lifecycle | Built (Phase 01)                                                |
| Lender go-live control and `lending.borrower_visible_product_versions`                                                                                             | Built (Phase 04): only live lenders can ever appear             |
| API route registry, idempotency, outbox worker, audit                                                                                                              | Built (Phase 03)                                                |

## 3. Scope

1. **Phone OTP delivery.** Supabase "Send SMS" hook (an API endpoint) calls a TRAI-DLT-registered SMS provider. Template carries the Android app hash (SMS Retriever, no SMS permission); iOS uses one-time-code autofill; Android Phone Number Hint instead of phone permissions. The hook has a 5-second budget; if the provider is slower the hook returns an error and the app offers a clear retry and (after two failures) an alternative route. OTP rate limits per number, per device and per IP; no OTP or number in logs.
2. **Consents.** Separate, unbundled, none pre-ticked, each recorded in `consent.records` against the exact published notice version and language shown: (a) terms of use, (b) privacy notice, (c) sharing the loan request with the named live lenders, (d) marketing (optional, separate; default off). Declining (d) blocks nothing. Notices are written, versioned and approved through the existing notice workflow (a Udofin staff screen to draft and publish them is included).
3. **Minimal profile.** Name (as the borrower wishes to be addressed) and preferred language. The phone number stays in the auth system only. No other personal data.
4. **Loan request.** Category (only categories the platform has enabled, from `lending.product_categories`), amount in rupees converted to integer paise, tenure, purpose from a fixed list. Validation on the server against category minimum tenure and against the union of limits of live lenders' approved products ("is anyone likely to offer this"), without revealing lender-specific rules.
5. **Resumable journey.** The server stores the step reached; the app resumes after restart or on another device. Drafts expire after a configurable period.
6. **Trust page,** reachable in at most two taps from every screen: Udofin's role as a lending service provider (not a lender), the live partner lenders with their registered names, Udofin's and each lender's grievance contact, how to complain and escalate, and where the privacy notice is.
7. **Account deletion in the app.** A borrower can request closure; the screen explains what is deleted now and what law requires to be kept (retention schedule D-25; until D-25 is decided, the screen says retention is "as required by law and by the lender" and lists the categories). Closure is a two-step flow with a confirmation, executed by the worker, audited, and refuses while a loan account is active.
8. **Device integrity (D-24).** Play Integrity token collected at sign-in and on high-risk actions, verified server-side; tiered policy per your decision.
9. **Admin and lender visibility.** Ops sees counts and states of requests without personal data; lenders see nothing until Phase 06.

## 4. Out of scope

KYC, bureau, offers, matching (Phase 06); e-sign and agreements (Phase 07); marketing notifications (only the consent ledger entry exists); iOS App Store release (Android first); languages beyond the decision in D-15.

## 5. Design decisions (my proposals)

| #   | Decision                                                                                                                                                                            | Why                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | SMS provider called from a small API route set as the Supabase hook, with the provider behind a port (`SmsSender`) and a labelled mock for tests that is blocked outside local/test | Provider can change; no mock can reach production (CLAUDE.md rule 9) |
| 2   | OTP lives only in Supabase Auth; Udofin never stores or logs it or the full number (masked last 4 in audit)                                                                         | Data minimisation                                                    |
| 3   | The journey state is a table `identity.onboarding_progress` (step, language, updated_at) written through functions, borrower-owned via RLS                                          | Resumable on any device, no client-side trust                        |
| 4   | A loan request is created in `draft`, becomes `submitted` only after all required consents are recorded in the same transaction                                                     | The ledger always matches what was submitted                         |
| 5   | Consent text lives in `consent.notices`, fetched by version and hash; the app shows the hash-verified text and records the notice id                                                | Proof of exactly what the borrower saw                               |
| 6   | Language packs are plain translation files reviewed by counsel; adding a language needs no code                                                                                     | D-15                                                                 |
| 7   | Integrity verdicts are stored as a coarse level (none/basic/device/strong) per session, never raw tokens                                                                            | Privacy and size                                                     |
| 8   | The trust page reads live data (lenders, grievance contacts) from the Phase 04 records; a lender without a grievance contact cannot go live (added as an activation condition)      | The page can never show an empty or stale promise                    |

## 6. Data and API

New: `identity.onboarding_progress`, `identity.device_attestations` (level only), `identity.deletion_requests`; additions to `consent.notices` seeds (terms, privacy, share-with-lenders, marketing, in the chosen languages); lender grievance contact fields (extension of the Phase 04 profile) and one new activation condition. All new tables: RLS enabled and forced, explicit grants, pgTAP including cross-borrower negative tests, added to the authorisation matrix.

New routes (borrower session, all idempotent POSTs where they write): `GET /v1/borrower/journey`, `POST /v1/borrower/profile`, `GET /v1/consent/notices`, `POST /v1/consent/decisions`, `GET /v1/categories`, `POST /v1/loan-requests` (+ `GET`, `POST …/submit`, `POST …/withdraw`), `GET /v1/trust`, `POST /v1/borrower/deletion-requests`, `POST /v1/integrity/verify`, and the SMS hook endpoint (called only by Supabase, authenticated by its signed header). Staff: draft/publish consent notices (two-person, existing change request type).

## 7. Mobile

Screens: welcome, number entry (Phone Number Hint), code (autofill), consents (one screen per consent or one list of independent switches: to be user-tested), name and language, request (category, amount slider with exact numeric entry, tenure, purpose), review and submit, status. Trust page and "Delete my account" in a persistent menu. Accessibility: screen-reader labels, text scaling, colour-independent states, no countdown that cannot be extended. The OTP screen keeps screenshot blocking. No permission is requested; the merged-manifest check from Phase 03's backlog is built here and must pass.

## 8. Acceptance criteria (each is a test)

1. First launch to a submitted request needs at most 4 deliberate interactions when autofill works (UI test; typing the amount excluded).
2. The merged AndroidManifest contains no SMS, contacts, phone, storage or media permission (release check); the OTP autofills on a test device.
3. If the SMS provider exceeds the hook budget, the hook fails cleanly, the app shows a retry, and no OTP is reported as sent.
4. Declining marketing consent blocks nothing; no consent box is pre-ticked; each consent is a separate ledger row with notice id and hash.
5. A request cannot be submitted without the terms, privacy and share-with-lenders consents recorded; withdrawing share consent stops any later routing.
6. Kill and reopen the app (and open on another device): the journey resumes at the last completed step.
7. Trust page within two taps from every screen; shows only live lenders; a lender without a grievance contact is not live.
8. A database scan of Udofin's core schemas finds no PAN-format, Aadhaar-format or date-of-birth data; logs and audit contain no OTP or full phone number (test with canary values).
9. Borrower A cannot read or change borrower B's journey, requests, consents or deletion request (pgTAP and API tests).
10. Account deletion refuses with an active loan account, otherwise completes via the worker and is audited.
11. Integrity policy behaves as decided (verdict levels, step-up on high-risk actions) with server-side verification.
12. The mock SMS sender and mock attestation cannot be enabled in staging or production (guard test).

## 9. External dependencies

Legal entity as DLT principal entity (D-02), registered sender header and templates, SMS provider contract (D-26 provider choice), app identity and signing for Play Integrity (D-08), privacy notice and consent wording approved by counsel, a production Supabase project in Mumbai with the paid plan, a Google Play developer account. Until these exist the flow runs against the labelled mock in local and test only, and production readiness is not claimed.

## 10. Questions for you (each with my recommendation)

| #   | Question                                                                                           | Recommendation                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **D-14 Marketing.** Service messages only at launch, with the ledger ready for per-product opt-in? | Yes (option a). No marketing sends in this phase.                                                                                         |
| Q2  | **D-15 Languages.** English only, English + Hindi, or more?                                        | English and Hindi; any other language later by translation file.                                                                          |
| Q3  | **D-24 Integrity.** Block, tiered, or none?                                                        | Tiered: allow with limits; require step-up OTP for offer acceptance, e-sign, bank-account change, mandate.                                |
| Q4  | Which SMS provider and who registers the DLT sender header and templates?                          | Choose from the two or three quotes you obtain; I will build behind the port so the choice is reversible.                                 |
| Q5  | Should the borrower give a name at all in this phase?                                              | Yes, as an optional "what should we call you" display name; the legal name is collected by the lender at KYC.                             |
| Q6  | Draft expiry for unsubmitted requests?                                                             | 30 days, then quietly closed.                                                                                                             |
| Q7  | Purpose list: use the existing list (education, medical, home renovation, …) or define your own?   | Start with the existing fixed list; lenders' products may restrict later.                                                                 |
| Q8  | Should an applicant under 18 or outside India be blocked?                                          | The age check needs date of birth, which we do not hold; leave it to the lender's KYC in Phase 06 and state the eligibility in the terms. |
| Q9  | Deletion while retention law applies: delete, anonymise, or hold?                                  | Anonymise the profile and unlink the phone immediately; keep consent and audit records for the period D-25 sets.                          |

## 11. Proposed commits

1. Spec approval and consent notice seeds. 2. Database: journey, attestations, deletion tables, grievance fields, activation condition, tests and matrix. 3. SMS port, mock, hook endpoint and rate limits. 4. Borrower API routes and tests. 5. Consent and notice staff screens. 6. Mobile screens and journey. 7. Integrity verification. 8. Deletion worker. 9. Manifest check, trust page, accessibility pass. 10. Docs, controls matrix, security review.

## 12. Risks

SMS delivery failures or DLT delays block launch (mitigation: provider chosen early, fallback retry route); consent text legal review time; Play Integrity coverage on older devices (tiered policy); the 2027 per-product consent rules may change the consent screen (ledger already supports per-product rows); and the unresolved bank-category and retention decisions (D-31, D-25) must not be assumed by this phase.
