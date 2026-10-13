# Phase 06 specification: lender routing, verification status, decisions and offers

**Status:** implemented on branch `claude/peaceful-babbage-14p1ci` (13 Oct 2026) and awaiting owner review; see section 15 for what was built, what differs from this draft and what stays open. Sections 1–14 are the original draft, kept for the record.
**Depends on:** Phases 01–05. **Roadmap:** `docs/product/roadmap.md`, Phase 06.
**Decisions it needs:** D-13, D-16, D-19, D-03 (lender systems), D-04 (Finbyx), plus the questions in section 11. Per your instruction, anything unanswered stays open; this spec builds what can be built correctly without it and lists exactly what is waiting (section 12).

## 1. Objective in plain English

A borrower who has sent a loan request chooses which live lenders may receive it. For each chosen lender, Udofin creates one application, passes the request to that lender, and the lender does everything that is regulated: identity checks, credit-bureau pull, account-aggregator consent and the credit decision. Udofin shows the borrower where each lender's process stands and, when lenders respond, shows **every** matching offer side by side in a neutral, documented order, names the lenders that did not offer, and keeps proof of what was shown. Udofin never decides, never holds KYC or bureau data, and never shows a "recommended" badge.

## 2. What exists already (not rebuilt)

| Area                                                                                                                                                                                | State                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `lending.applications` (unique per request and lender), `application_transitions`, append-only `application_events`, lifecycle mirrored in `packages/domain`                        | Baseline (Phase 01)    |
| `lending.offers` (terms immutable, one live offer per application, only the borrower accepts), `lending.matching_rule_versions`, `lending.offer_displays` (append-only display log) | Baseline (Phase 01/02) |
| `lending.borrower_visible_product_versions` (only live lenders) and the product snapshot on loan requests                                                                           | Phase 04/05            |
| Consent ledger with `share_with_lenders` purpose and per-notice versioning; loan requests with consent check on submit                                                              | Phase 05               |
| `onboarding.integrations` (a lender's integrations, with tests or approved exceptions) and the lender go-live gates                                                                 | Phase 04               |
| Outbox and worker, idempotency, signed-webhook verification pattern, SMS and integrity ports                                                                                        | Phase 03/05            |

## 3. Scope

1. **Lender routing with consent.** Borrower picks one or more lenders from those that currently have a borrower-visible product matching the request. A per-lender consent is recorded for each (the lender is named in the wording and the notice version is stored). An application row exists only where such a consent is current; the database refuses otherwise.
2. **Lender connector port.** One interface every lender integration implements: `submitApplication`, `getStatus`, `getOffers`, and signed inbound callbacks. A labelled mock connector for local and tests; real connectors are written per lender once their LOS/API and credentials are known (section 11, Q1). Credentials are per lender, in the secrets store, never in the app.
3. **Verification status, not verification data.** Udofin stores per application only a lender-reported status for each check (`kyc`, `bureau`, `account_aggregator`: not started, in progress, completed, failed, plus the lender's reference id and time). It stores no document, number, image, report or score. Where the lender's flow needs borrower input, the app hosts the lender's screen or opens the lender's link; data goes to the lender, not through Udofin's database.
4. **Decision intake.** Lender decisions arrive as signed, idempotent callbacks (or polling where a lender has no callbacks). Each is recorded as an application transition by the system actor with the lender's rule/version reference and reason code. Udofin never infers or overrides a decision.
5. **Offers.** An offer is created only from a lender decision, with the six display fields, the full cost fields already in `lending.offers`, validity and a **KFS reference supplied by the lender**. An offer without a KFS link is not shown.
6. **Comparison screen.** Shows all valid offers for the request, each with lender name, amount, tenor, APR, monthly repayment, penal charges and a working KFS link, and names lenders that were asked and did not offer (declined, no response, ineligible). No badges, countdowns or pre-selected option. Default order follows the approved rule version (D-16); the borrower can re-sort by the other disclosed metrics.
7. **Display log.** Every time a comparison is served, one `offer_displays` row per offer is written with rank, rule version and time, plus a header row listing the lenders that did not offer.
8. **Platform filters.** Tenure floor (already enforced by category); on iOS, offers above 36% APR hidden if D-19 is confirmed (the filter is built, off by default).
9. **Lender-scoped encryption.** A `KeyManagement` port with per-lender keys for any lender-owned artefact Udofin must relay or hold briefly. A local development adapter now; the AWS KMS (Mumbai) adapter when the AWS environment exists.
10. **Borrower withdrawal and expiry.** The borrower can withdraw an application at any stage before acceptance; applications and offers expire by their own deadlines through the existing lifecycle.

## 4. Out of scope

Offer acceptance, KFS generation, cooling-off, e-sign, e-stamp and disbursement (Phase 07); repayment and collections (Phase 08); Finbyx integration (blocked until D-04); AI features; any scoring, eligibility judgement, ranking by fees, or "pre-approval" claim by Udofin; iOS release.

## 5. Design decisions (my proposals)

| #   | Decision                                                                                                                                                                                                                                                                                | Why                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Applications are created by a database function `lending.route_request(request_id, lender_ids[])` that checks a current per-lender consent and a visible matching product, and is the only creator; a trigger refuses any other insert                                                  | "No application without consent" holds on every path (CLAUDE.md rule 2/3)                             |
| 2   | Per-lender consent is a new purpose `share_with_lender` with the lender organisation id stored in the consent evidence, one row per lender                                                                                                                                              | The wording must name each recipient; a single blanket consent is not enough for named lenders        |
| 3   | What the lender receives at routing is a fixed, minimal payload: request fields (category, amount, tenure, purpose key), the product version, the borrower's display name if given, the borrower's phone number, language and a Udofin reference. Nothing else                          | Data minimisation; the lender collects PAN, date of birth and everything else itself in its own flow  |
| 4   | The phone number is read by the system at send time from the auth provider and sent over the connector; it is never copied into a Udofin table, event payload or log                                                                                                                    | Rule 3; the same boundary as Phase 05                                                                 |
| 5   | Connectors run in the worker through the outbox (`application.routed` event); retries are idempotent with the application id as the key                                                                                                                                                 | Outbound calls must not sit inside a user transaction; the lender gets exactly one logical submission |
| 6   | Inbound callbacks: one endpoint per lender connector, Standard-Webhooks-style signature with a per-lender secret, 300 s window, message-id de-duplication in the database, then a function applies the transition. Unknown or out-of-order events are stored as rejected, never applied | Same replay and ordering defences as the Phase 05 review, with a shared store                         |
| 7   | An offer's APR, EMI, tenor and charges come from the lender and are validated for internal consistency (principal, instalment count × amount ≥ principal, total repayable ≥ principal) but never recalculated or "corrected" by Udofin                                                  | The lender's KFS is the legal statement; Udofin only displays and flags inconsistencies to the lender |
| 8   | The comparison is a database view plus a function that returns the ordered list for the rule version in force and writes the display log in the same transaction                                                                                                                        | Display and proof cannot drift apart                                                                  |
| 9   | Ordering uses only lender-supplied numbers and the approved rule version; Udofin fees and lender commercial terms are not columns the ordering function can read                                                                                                                        | Provable neutrality (MLD-03)                                                                          |
| 10  | Lenders that did not offer are shown by name with the neutral reason class (declined, no response in time, not eligible for this product), never with credit details                                                                                                                    | The rule requires naming them; credit reasons are the lender's to communicate                         |
| 11  | Verification data never lands in Udofin storage; the lender-scoped encrypted store exists only for short-lived relay cases and is off unless a lender needs it                                                                                                                          | Rule 3 and ADR 0009                                                                                   |
| 12  | Every connector, callback and display is audited with identifiers only                                                                                                                                                                                                                  | No PAN, Aadhaar, OTP, phone or name in logs, events, URLs or errors                                   |

## 6. Data and API (new)

New tables (RLS enabled and forced, explicit grants, lender-scoped, pgTAP with cross-tenant negatives, added to the authorisation matrix): `lending.application_checks` (application, check kind, status, lender reference, times), `lending.lender_decisions` (inbound decision log with message id, rule/version reference, reason class, applied or rejected), `lending.inbound_messages` (de-duplication), `lending.comparison_runs` and `lending.comparison_nonoffers` (what was shown and who did not offer), `lending.lender_connectors` (per-lender connector kind, status; no secrets), `consent` additions for `share_with_lender`. Extensions: `lending.offers` gets `kfs_url` (lender-hosted, domain allow-listed per lender) until Phase 07 generates documents.

Borrower routes (borrower session, idempotent POSTs): `GET /v1/lenders/matching?loanRequestId=`, `POST /v1/loan-requests/{id}/route` (lender ids + consent notice ids), `GET /v1/applications`, `GET /v1/applications/{id}` (status, checks, events), `POST /v1/applications/{id}/withdraw`, `GET /v1/loan-requests/{id}/offers` (the comparison), `GET /v1/offers/{id}/kfs` (redirect to the lender KFS link).
Lender portal: applications queue with the routed request fields and check statuses, record check status, record decision, issue offer (reuses maker-checker where a lender configures it). Platform staff: matching-rule version create and approve (two-person, existing change-request type), connector status, comparison-run viewer without personal data.
System: `POST /v1/hooks/lender/{connector}` (signed), worker handlers for `application.routed`, status polling and offer expiry.

## 7. Mobile screens

Choose lenders (each with the named per-lender consent, none pre-ticked), my applications with per-lender status and per-check status (lender-reported, labelled as such), offers comparison (all six fields, KFS link, non-offering lenders named, sort control, no badges), offer detail, lender-hosted verification handoff (opens the lender's flow; returns to the status screen). English and Hindi, all states, accessibility labels, same offline/retry behaviour as Phase 05.

## 8. State and failure handling

Applications follow the existing lifecycle (`submitted` → `under_review` → `approved` or `rejected` …); Phase 06 adds no lender decision logic. A lender that is slow or down leaves the application `submitted` with a visible "waiting for lender" state and a retry-safe resend; after the lender's response deadline the system marks it expired (a named, non-offering lender). A lender that is suspended mid-flight keeps its existing applications visible but receives nothing new. An invalid callback is stored as rejected and alerts staff; it never changes an application. A lender that returns an inconsistent offer is rejected back to the lender, not shown.

## 9. Regulatory controls (labels honest)

MLD-01, MLD-02, MLD-03 (multi-lender display, neutral order, six fields, KFS link; confirmed in primary text per the matrix), KYC-01 (lender records "KYC complete", Udofin shows status only), KYC-02 (Aadhaar only under the lender's own route), DAT-02 (separate consent per lender and rail; no consent, no call), DAT-03/DAT-04 (no Aadhaar number or biometrics), CRI-01 to CRI-04 (bureau under the lender's membership; Udofin holds no report; CRI-04 notice wording is for the lender), DLC rows on KFS before acceptance (Phase 07). New matrix rows will be added with the build. Platform filters follow APP-04 (iOS, pending D-19). No claim of compliance is made.

## 10. Acceptance criteria (each is a test)

1. With four configured lenders where two decline, the comparison shows two offers with all six fields and a working KFS link, and names the two that did not offer (API and database test).
2. Changing Udofin's fee or commercial configuration does not change the order; identical inputs give identical order and the same rule version (test).
3. Every comparison served writes one display row per offer with rank, rule version and time, plus the non-offering lenders (test).
4. No application exists for a lender without a current per-lender consent for that request; direct inserts and stale or withdrawn consent are refused (pgTAP).
5. A KYC, bureau or AA initiation without a selected lender and a current consent is rejected (API test with the mock connector).
6. Lender A cannot read lender B's applications, checks, decisions or offers; borrower A cannot read borrower B's; a dump of Udofin's core schemas contains no PAN, Aadhaar, date of birth, bureau data or KYC image (pgTAP, canary scan).
7. A replayed, unsigned, stale, out-of-order or unknown inbound message changes nothing and is recorded as rejected (test).
8. An offer without a KFS reference or with inconsistent terms is not displayed (test).
9. No "recommended" label, countdown or default selection exists in the screen data or UI (contract test and review).
10. On an iOS-flagged build with the filter on, an offer above 36% APR is not returned (test); the filter is off by default.
11. The mock connector is blocked in staging and production (guard test).
12. A withdrawn or suspended-lender application stops all outbound calls (test).

## 11. Questions for you (each with my recommendation)

| #   | Question                                                                                                                                                  | Recommendation                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | **Lender systems.** How do MGM Financiers and Megapode Vyapar receive an application and send decisions: own LOS with an API, Finbyx, e-mail/portal only? | Build to the connector port now with a mock; write each real connector when the lender gives its API. A portal-only lender can use the lender portal screens (the lender keys the decision in).                                            |
| Q2  | **D-13 vendor structure** for KYC, bureau and AA.                                                                                                         | (a) Tri-party agreements using the lender's credentials, or (b) each lender contracts the vendor; Udofin only orchestrates. Not (c). Phase 06 builds neither vendor integration until this is decided and the lender supplies credentials. |
| Q3  | **D-16 default order.**                                                                                                                                   | Lowest APR, then lowest monthly repayment, disclosed on screen, with the borrower able to re-sort; rule changes versioned and approved by you.                                                                                             |
| Q4  | **D-19 iOS filter.**                                                                                                                                      | Build the filter (off by default); decide before any iOS build and ask Apple.                                                                                                                                                              |
| Q5  | **What the lender receives at routing** (design decision 3), including the borrower's phone number.                                                       | Approve the fixed minimal payload; the phone number goes to a named, consented lender only.                                                                                                                                                |
| Q6  | **PAN, date of birth, income.** The research note suggested Udofin could collect these for pre-qualification.                                             | No. The lender's own flow collects them; Udofin keeps none (rule 3).                                                                                                                                                                       |
| Q7  | **KFS link in Phase 06.** Document generation is Phase 07.                                                                                                | The lender supplies a lender-hosted KFS URL (allow-listed domain) with each offer; no link, no display. Replaced by generated KFS in Phase 07.                                                                                             |
| Q8  | **Account Aggregator.**                                                                                                                                   | Status-only in Phase 06 (the lender's FIU flow); Udofin builds no AA client.                                                                                                                                                               |
| Q9  | **Response deadlines.** How long may a lender take before it counts as "no response" and its offer window closes?                                         | Configurable per lender service; default proposal: 48 hours to respond, offers valid at least 7 days (lender may set longer).                                                                                                              |
| Q10 | **Number of lenders per request.**                                                                                                                        | Up to all matching live lenders, with a cap you set (proposal: 5), no pre-selection.                                                                                                                                                       |
| Q11 | **Per-lender KMS.** AWS is not yet set up.                                                                                                                | Port and local adapter now; AWS KMS adapter when the AWS account exists.                                                                                                                                                                   |
| Q12 | **Finbyx.**                                                                                                                                               | No Finbyx connector until D-04 (Mumbai). The generic connector covers it later.                                                                                                                                                            |

## 12. What stays open (waiting for your information)

Q1 (lender APIs and credentials), Q2/D-13 (vendor structure), D-16 and D-19 final answers, Q9 timings, the lender grievance and KFS hosting details, the per-lender consent wording and its approval (D-37), and everything already open from Phase 05 (D-34 to D-38, D-25, D-35). I will keep a single consolidated list and give it to you after the last phase, as you asked; nothing is assumed in code, and each missing item is a named configuration or reference-data gap that fails honestly.

## 13. Proposed commits

1. Spec approval. 2. Database: routing function and trigger, checks, decisions, inbound messages, comparison tables, offer KFS reference, grants, tests, authorisation matrix. 3. Connector port, mock connector and guard, key-management port. 4. Routing API and worker (outbox send, retries). 5. Inbound callback endpoint and decision application. 6. Offers issue and validation, comparison function, display log, filters. 7. Lender portal screens (queue, check status, decision, offer). 8. Platform screens (matching rule versions, connector status). 9. Mobile screens, English and Hindi. 10. Tests, controls matrix rows, ADR, security review, docs.

## 14. Risks

No real lender connector can be written until the lenders' systems are known, so end-to-end behaviour with a real lender is untested in this phase. Per-lender consent wording needs legal approval. The 2027 per-product consent rules may change the routing screen. Offer data quality depends on each lender; Udofin only validates consistency. Without lenders ready, the comparison screen can be demonstrated only with mock data, which will be labelled and blocked from production.

## 15. Implementation record (13 October 2026)

**Built.** Migrations `20261015000800`–`…802`; `LenderConnector` and key-management ports with labelled mocks
(`packages/adapters`); routing, lender and platform routes (`docs/api/routing.md`); worker handlers (send, reconcile);
a separate signed-callback receiver; mobile screens in English and Hindi; lender-portal application screens.

**Differs from the draft.**

- Borrower routes follow the shape in `docs/api/routing.md` (selection → per-lender consent → route), not the single
  `POST /route` of section 6.
- Callbacks are served by a separate process rather than `POST /v1/hooks/lender/{connector}` on the public API, so the
  public API never holds the system database login.
- Platform screens (connector settings, matching-rule approval) are **API only**; no ops-portal screen was built.
- The `auth.users` phone is read inside `begin_transmission`; it never touches Udofin tables, the outbox, audit or logs.
- Payload cap, response window and validity minimums are defaults awaiting approval (D-48, D-49, D-45).

**Acceptance criteria (section 10) and the tests that evidence them.**

| #   | Evidence                                                                                                                                                                                               | Run                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| 1   | `routing.integration` (two of four lenders decline → two offers, two named) and pgTAP 011                                                                                                              | yes                            |
| 2   | Integration 'lists the valid offers in the approved order'. Independence from Udofin fees holds by construction (`compare_offers` reads no commercial data); no test varies fee data. Partly evidenced |
| 3   | pgTAP 011 display and non-offer rows with rule version                                                                                                                                                 | yes                            |
| 4   | pgTAP 011 consent required, stale and withdrawn consent refused, direct insert refused                                                                                                                 | yes                            |
| 5   | Not applicable: no KYC/bureau/AA initiation exists (status only, D-13). Routing without consent is refused (see 4)                                                                                     | n/a                            |
| 6   | pgTAP 011 and 006 cross-tenant negatives; canary scan for phone in `routing.integration` (no PAN/Aadhaar field exists to store)                                                                        | yes                            |
| 7   | `lender-callbacks` cases in `routing.integration` (replay, bad signature, stale timestamp, unknown lender) and pgTAP message-id de-duplication                                                         | yes                            |
| 8   | pgTAP 011 and routing integration: offer without a valid KFS link is held and not displayed                                                                                                            | yes                            |
| 9   | Contract schema has no badge/countdown/preselect field; mobile `routing.test.ts`                                                                                                                       | yes (no UI review by a person) |
| 10  | pgTAP 011 section 12: with the filter on, an offer above 36% APR is omitted and the omission recorded; off by default. Run: yes                                                                        |
| 11  | `lender-connector.test.ts` (mock blocked in staging and production) and the callback 503                                                                                                               | yes                            |
| 12  | Integration: a withdrawn application's job is stopped before sending. A suspended-lender case is not separately tested. Partly evidenced                                                               |

**Not tested:** any real lender; real SMS; the mobile screens on a device; browser tests of the new portal screens;
the Supabase-stack run of pgTAP before CI; load or soak behaviour of the worker.
