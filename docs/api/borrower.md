# Borrower API (Phase 05)

The full machine-readable description is `openapi.json` (regenerate with `pnpm --filter @udofin/api openapi`; a test fails if it is stale). This page explains the rules that the schema cannot.

## Who can call it

Every route except the Supabase hook takes the borrower from the verified token. A staff, lender or platform identity gets `403` (`borrower_only` or `no_active_access`); a borrower never supplies, and cannot choose, their own id. Rows are read under row-level security as the borrower and written only through checked database functions, so a request for another borrower's object answers `404` (not found, with no hint that it exists).

## Conventions

- Errors are RFC 9457 problem+json with a stable `code`. Clients map codes to text; they never show raw server messages.
- `POST` routes marked idempotent need an `Idempotency-Key` header. A repeat with the same key and body replays the first answer (`Idempotent-Replayed: true`).
- Money is integer paise (`amountMinor`). Tenure is days (`tenureDays`); the app counts a month as 30 days (D-36).
- Language is `en` or `hi`. Unknown values answer `422`.
- No route accepts PAN, Aadhaar, date of birth or bank details. Request schemas are strict, so unknown fields are refused.

## Account and profile

| Route                                | Purpose                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GET /v1/borrower/me`                | Profile, journey facts, current consents, preferences, marketing availability, integrity level |
| `POST /v1/borrower/profile`          | Optional display name and language                                                             |
| `POST /v1/borrower/profile/complete` | Mark the profile complete                                                                      |
| `POST /v1/borrower/preferences`      | Whether optional service updates go by SMS (security codes are always sent)                    |

The journey is reported as separate facts: `accountCreated`, `profileStarted`, `profileCompleted`, `consentsCompleted`, counts of drafts and submitted requests. `lenderKyc` is always `not_started` and `eligibility` always `not_assessed`: nothing in this phase verifies or assesses anyone.

## Consent

`GET /v1/consent/notices?language=` returns the latest published wording per purpose (terms of use, privacy notice, sharing with lenders). Where a language is not published, English is returned with `languageFallback: true`. Wording with `reviewStatus: requires_review` is shown with a label but cannot back a required consent.

`POST /v1/consent/decisions` records `granted`, `denied` or `withdrawn` for one notice id. It stores the notice version and SHA-256, language, channel (`mobile`), screen and app version; each call is a new row. Marketing answers `409 marketing_disabled` while it is off. An older version than the current one answers `409 notice_superseded`.

## Loan requests

| Route                                  | Notes                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/loan-purposes?language=`      | The fixed purpose list with stable keys. **Empty until the owner supplies it (D-34).** Others are rejected `422 purpose_unknown`. |
| `GET /v1/borrower/categories`          | Enabled categories and their minimum tenure                                                                                       |
| `GET /v1/borrower/products`            | Visibility only, read from the Phase 04 view (live lenders, approved versions). Not an offer.                                     |
| `POST /v1/loan-requests`               | Create a draft. Optional `productVersionId` (must be borrower-visible); the product version is snapshotted.                       |
| `POST /v1/loan-requests/{id}/draft`    | Edit a draft with `expectedVersion`; stale edits answer `409 version_conflict`. Editing never extends the expiry.                 |
| `POST /v1/loan-requests/{id}/submit`   | Needs `expectedVersion`. Returns the reference (`UR-` + 10 hex). Repeats return the same reference.                               |
| `POST /v1/loan-requests/{id}/withdraw` | Draft or submitted                                                                                                                |
| `GET /v1/loan-requests`, `…/{id}`      | List (keyset cursor) and detail with events                                                                                       |

States: `draft`, `submitted`, `offer_selected`, `withdrawn`, `expired`, `closed` (later phases use the last two beyond `expired`). A draft expires 30 days after creation. This is enforced by the database on read (an overdue draft reads as `expired`) and on write (`409 draft_expired`), not only by a housekeeping job; expiry does not delete anything.

Submission also requires: the three required consents currently granted, a known purpose, a valid category and tenure, a product that is still available, and an account that is not closing. These are checked by a database trigger on every path, not only the API.

## Step-up one-time code (D-24)

`POST /v1/stepup/challenges` with `action` (`offer_acceptance`, `esign`, `bank_account_change`, `mandate_creation`) and `contextRef` (an opaque object id) sends a 6-digit code. The code is hashed with a server secret, expires in 5 minutes, allows five wrong tries, works once, and is bound to that action and object. `delivery` is `accepted`, `rejected`, `timeout` or `not_configured`; `accepted` means the SMS provider took the message, never that it arrived. `POST …/{id}/verify` returns `verified`, `invalid`, `expired`, `locked`, `not_found` or `already_verified`.

Later phases call `identity.stepup_consume(action, contextRef)` inside the sensitive action's own transaction. No Phase 05 action does yet.

## Device integrity (D-24)

`POST /v1/integrity/nonce` issues a single-use nonce. `POST /v1/integrity/verify` sends a token and the nonce to the server's verifier, which decides the level (`none`, `basic`, `device`, `strong`); only the level is stored. The client never states a level. With no verifier configured the answer is `unavailable` and the level stays `none`. Integrity and the one-time code are separate checks; neither implies the other.

## Account deletion (D-25, partly)

`POST /v1/borrower/deletion-requests` records a request and queues `borrower.deletion_requested`; the worker runs `identity.process_deletion`, which anonymises the profile (name removed, status closed), deletes preferences, device assessments, codes and nonces, withdraws open drafts, and keeps consent and audit records. It is refused (recorded as `blocked`) while a loan account is active. Repeating a request or the processing is safe. `signInIdentityRemoved` stays `false`: removing the phone from the authentication provider needs its admin interface and a retention decision (D-38). After anonymisation the borrower has no borrower access, so status for a closed account is read from the staff side.

## Supabase "Send SMS" hook

`POST /v1/hooks/send-sms` is called by Supabase Auth, not by apps. It verifies the Standard Webhooks signature (secret `SEND_SMS_HOOK_SECRET`, 300-second window, constant-time comparison) over the raw body, then sends the code through the configured `SmsSender` within the hook's time budget. It answers `200` only when the provider accepted the message; a slow or failing provider answers `500` with `sms_unavailable`, so the app can offer a retry and no code is reported as sent. The code and number are never logged. Configuration is in [`../operations/supabase-setup.md`](../operations/supabase-setup.md).
