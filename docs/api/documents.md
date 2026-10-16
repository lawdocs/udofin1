# KFS, loan documents, acknowledgement and acceptance API (Phase 07)

Machine-readable description: `openapi.json`. This page states what the schema cannot. Status: implemented and tested
with a labelled mock signing provider and a mock SMS sender only. **No real signing or delivery provider has been
configured or tested.** All wording, rules and layouts seeded in the database are **DRAFT fixtures for legal and
compliance review**, not approved text.

## Principles

- The lender is authoritative. Udofin structures and displays the lender's figures; it never recalculates, rounds or
  corrects them. A difference between the KFS data and the offer is _flagged_ (the submission is held), never altered.
- Two validities, never mixed: the **offer** validity is the lender's; the **KFS** validity is at least 3 working days
  (tenor ≥ 7 days) or 1 working day (tenor < 7 days), counted in the lender's _approved_ working-day calendar (IST).
  Without an approved calendar, preparation stops with `calendar_missing`.
- Applicability is configuration (`documents.applicability_rules`), per lender category. A rule must be approved by a
  second person; only the NBFC rule and the RBI Annex I layout exist, as drafts. A lender category with no approved rule
  gets `applicability_unresolved` and no document. Banks and UCBs are not assumed.
- Documents are immutable versions with a SHA-256, kept in private storage. Approval names the exact hash. Issuance is
  a separate lender step; automatic issuance is off.
- Acknowledgement is an explicit borrower act (never pre-selected, never inferred). Offer acceptance consumes a step-up
  bound to that offer id in the same transaction as the acceptance record. An OTP is not an electronic signature.

## Lender routes (staff token with the lender role; POSTs idempotent)

| Route                                                | Purpose                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST/GET /v1/lender/offers/{id}/kfs-data`           | Submit KFS facts (`kfs_data_v1`, or `kfs_declared_v1` for a file you produce) and see validation |
| `POST /v1/lender/offers/{id}/generation`             | Prepare a draft from accepted data (same request returns the same job)                           |
| `POST /v1/lender/offers/{id}/kfs-upload`             | Register your own PDF (≤ 8 MiB) against declared facts                                           |
| `GET /v1/lender/documents`, `…/content`, `…/history` | List, fetch the exact file (recorded), history                                                   |
| `POST /v1/lender/documents/{id}/approve`             | Approve the exact SHA-256; preparer ≠ approver unless self-approval is enabled                   |
| `POST …/reject`, `…/issue`, `…/withdraw`             | Reject a draft, issue an approved document, withdraw (not after acceptance)                      |
| `POST /v1/lender/templates`, `…/{id}/approve`        | Propose and approve your own wording (different persons)                                         |

## Borrower routes

| Route                                  | Purpose                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /v1/applications/{id}/documents`  | Current offer, KFS, acknowledgement, acceptance, agreement, signing state               |
| `GET /v1/documents/{id}/kfs`           | KFS as sections plus the current acknowledgement wording                                |
| `GET /v1/documents/{id}/content`       | The exact stored file (each retrieval recorded)                                         |
| `POST /v1/documents/{id}/acknowledge`  | Explicit acknowledgement of this version, wording version and language                  |
| `POST /v1/offers/{id}/accept`          | Accept the revision; needs the KFS acknowledged, the KFS and offer valid, and a step-up |
| `POST/GET /v1/agreements/{id}/signing` | Start / read signing; unavailable until a provider and legal method are approved        |
| `POST /v1/documents/{id}/delivery`     | Request a content-free "documents ready" SMS; email is `not_configured`                 |

## Platform routes (Udofin staff, two-person)

`/v1/platform/document-rules`, `…/document-templates/{id}/compliance-approval`, `…/document-calendars`,
`…/lenders/{id}/document-self-approval`. The compliance reviewer is recorded as a named reference supplied by the
approver; the system never invents or defaults a reviewer (the owner has not yet designated the compliance approver).

## Stable error codes (selection)

`calendar_missing`, `applicability_unresolved`, `applicability_ambiguous`, `kfs_data_invalid`, `kfs_input_held`,
`draft_stale`, `hash_mismatch`, `segregation_of_duties`, `acknowledgement_required`, `explicit_action_required`,
`kfs_expired`, `offer_expired`, `offer_superseded`, `another_offer_accepted`, `already_accepted`,
`signing_not_available`, `mock_signing_blocked`, `proposal_no_taken`, `wording_not_approved`, `reviewer_required`.
Clients map codes to text; messages never contain borrower data.

## Delivery evidence

A provider accepting a message is recorded as `provider_accepted`, never as delivered. `delivered` exists only when a
verified provider receipt arrives (none is configured). The SMS carries no document content or link.
