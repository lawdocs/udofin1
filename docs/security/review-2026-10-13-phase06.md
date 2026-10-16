# Security review: Phase 06 (lender routing, status, decisions, offers, comparison)

Date: 13 October 2026. Method: an independent static review by a read-only reviewer agent, then fixes and re-test by
the engineer. The reviewer ran no code; the fixes were tested with pgTAP and the API integration suite. This is not a
penetration test and not an external audit.

## Fixed in this phase

| #   | Finding                                                                                                                                                         | Fix                                                                                                       | Evidence                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Medium. Consent withdrawal and `route_selection` could miss each other under READ COMMITTED, leaving a manual-lender application visible with consent withdrawn | `record_lender_decision` now locks the loan-request row first (same row `route_selection` locks)          | Existing race tests still pass; the specific interleaving of the review was reasoned about, not reproduced with two sessions |
| 2   | Medium. Withdrawal failed if the wording had been retired                                                                                                       | Withdrawal accepts a retired notice; granting still needs the published, approved, latest wording         | Reasoned; no dedicated test (listed below)                                                                                   |
| 3   | Medium. The 7-day validity floor could be bypassed by back-dating `issuedAt`                                                                                    | Validity is measured from now                                                                             | pgTAP: back-dated issue date with one day left is held                                                                       |
| 4   | Low-medium. A send that never recorded its result could stay `transmitting` forever                                                                             | `process_deadlines` moves it to `uncertain` after 5 minutes and queues a reconcile (never a blind resend) | Reasoned; no dedicated test (listed below)                                                                                   |
| 6   | Low. The lender list kept the borrower's display name after consent was withdrawn                                                                               | Name is null once consent is withdrawn                                                                    | Reasoned; no dedicated test                                                                                                  |
| —   | UI: the withdraw-offer form filtered on the wrong status (`open` instead of `issued`)                                                                           | Fixed                                                                                                     | Portal tests render the form logic only                                                                                      |
| —   | Private `apply_*` functions executable by signed-in users?                                                                                                      | Confirmed not executable                                                                                  | pgTAP: SQLSTATE 42501 on a direct call                                                                                       |

## Accepted or open (not fixed in Phase 06)

- **Offer sanity (finding 5).** Offer terms are range-checked individually, and total repayable must be at least the principal, but principal is not compared with the request or product range, and nothing recomputes instalments, by design (offers are stored exactly as the lender states). Owner decision: add bounded consistency checks? Recommendation: require principal inside the product's amount range.
- **Callback oracle (finding 7).** Active `api` lenders answer 503 where unknown ones answer 404, which reveals which lender ids are active API connectors; one database lookup happens before authentication. Bounded by the rate limit; revisit when the first real scheme exists.
- **Signing-secret names.** Any name matching the pattern is accepted; two lenders could point at one variable. Recommendation: require a fixed prefix when real production secrets exist (D-47). The signed content does not bind the lender id; add it with the first real scheme.
- **Message-id de-duplication is permanent**, including for a message rejected for a transient reason. Lenders must resend with a fresh id. To be documented in each lender's integration pack.
- **Contact harvesting.** A compromised lender user could read up to 30 numbers a minute, each audited without the number. Consider a daily cap and alerting on audit volume before the first real lender.
- **Client-stated platform.** The iOS filter keys on the platform the client states, so it is not a control against a malicious client (D-19).
- **Append-only growth** of comparison logs; consider de-duplicating identical views within a window.
- **Baseline grants** still allow lender database roles to write application and offer rows directly; the portal and API only use the functions. Tighten before a lender is given direct database access (none is planned).
- **Detail page lookup** scans at most 8 pages of 25 applications, so older applications can show "not found" until a direct lookup route exists.

## Tests the review asked for that do not exist yet

Retired-notice withdrawal; stale-`transmitting` sweep; display name hidden after withdrawal; a two-session reproduction of finding 1.
