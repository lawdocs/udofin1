# ADR 0029 — Borrower onboarding and loan request: database-enforced rules, evidence-first consent, separate security checks

**Status:** Accepted (pending owner review of the Phase 05 PR) · **Date:** 13 Oct 2026

## Context

Phase 05 lets a borrower sign in, set a minimal profile, give separate consents and send a loan request, in English or Hindi. Udofin keeps minimal data; lenders decide; consent must be provable; and several things the flow touches are not yet decided or available (SMS provider and DLT registration, Play Integrity credentials, consent wording approval, retention schedule, the fixed purpose list). The design must be correct without them and must never pretend they exist.

## Decision

1. **Rules live in the database, the API repeats them.** Profile, consent, request, step-up, integrity and deletion changes are `SECURITY DEFINER` functions that read the caller from the token claim (`private.my_borrower_id()`), never from input. A trigger on `lending.loan_requests` enforces expiry, purpose, the three required consents, product availability, closing accounts and reference generation on every path, including a direct update.
2. **Draft expiry is a property of the data.** `expires_at` is set once (30 days after creation, from `lending.draft_lifetime()`); edits never move it. Reads show an overdue draft as `expired` through a view, writes refuse it, and a worker job only keeps the stored status honest. Expiry never deletes.
3. **Consent is one append-only row per decision**, carrying the notice id, version and SHA-256, language, channel, screen and app version; withdrawal is a new row. Published wording is immutable including its review status; wording flagged `requires_review` cannot back a required consent, so Hindi users are offered the approved English text until Hindi is approved. Marketing is a purpose in the same ledger but cannot be recorded while `consent.marketing_enabled()` is false.
4. **The journey is a set of separate facts**, not one status that could be read as "verified". The API always reports lender KYC as `not_started` and eligibility as `not_assessed`.
5. **Step-up code and device integrity are different checks.** A one-time code is generated in the API, hashed with an HMAC pepper, stored only as a hash, bound to action and object, limited to five tries and five minutes, and single use. Device integrity yields a coarse level the server decided from a verifier; the client's claim is ignored. A mock verifier exists for tests only and is refused outside local and test.
6. **SMS goes through a port** (`SmsSender`) with a timeout wrapper and honest results (`accepted`, `rejected`, `timeout`, `not_configured`). Step-up codes are sent in-request, not through the outbox, because the plaintext code must not be stored in an event payload. The Supabase Send SMS hook is a signed public route (Standard Webhooks, 300 s window).
7. **Deletion anonymises.** A worker handler runs `identity.process_deletion`, which is idempotent, refuses while a loan account is active, and keeps consent and audit records. Removal of the phone identity in the authentication provider is tracked as pending and never claimed.
8. **The app keeps the request form above the translated screens**, so changing language only changes strings. Submit retries reuse one idempotency key and saved version until anything is edited or any answer other than "no connection" arrives.
9. **No placeholder data.** The purpose list, notice wording, SMS provider and DLT values are absent until supplied; features that need them answer honestly.

## Consequences

Positive: one rule set for every client; no way to submit an expired or unconsented request; evidence of what each borrower saw; a clean path to add a provider adapter, languages and marketing consent later. Negative: logic in SQL needs migrations to change; Hindi borrowers cannot give required consent in Hindi until approval; account closure leaves the phone identity until D-38 is decided; tenure is counted as 30-day months in the app (D-36).

Risks: SMS delivery and DLT delays block launch; the 2027 per-product consent rules may change the consent screen (the ledger already holds per-purpose rows); mock providers must never be configured in a deployed environment (a startup check refuses it).

## Verification

`supabase/tests/010_borrower_onboarding.test.sql` (82 assertions), updated `006_authorization_matrix.test.sql`, `services/api/test/integration/borrower.integration.test.ts` (19 tests, over HTTP against a real database), `packages/adapters/src/sms.test.ts`, `apps/mobile/test/*.test.ts`, `packages/auth-client/test/misc.test.ts`.
