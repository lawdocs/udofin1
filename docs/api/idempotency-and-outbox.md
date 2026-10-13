# Idempotency and the transactional outbox

Status: implemented in Phase 03 (13 Oct 2026). Code: `services/api/src/idempotency`, `services/api/src/workers`, migration `20261013000730_idempotency_and_outbox.sql`. Decisions: [ADR 0027](../adr/0027-idempotency-in-postgres.md), [ADR 0011](../adr/0011-background-jobs-outbox-pg-boss.md) (amended).

We do **not** claim exactly-once processing. We design for safe retries: duplicates are detected and replayed, handlers are idempotent, and anything involving an outside system is reconciled.

## 1. Idempotency of requests

**Which operations.** Every state-changing authenticated POST: today `POST /v1/admin/change-requests` and the approve and reject decisions. A test fails if a new POST is added without `idempotent: true`. Reads never use it.

**Contract (also in the OpenAPI document).**

| Situation                                                       | Result                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| No / malformed `Idempotency-Key` (16–128 chars `A-Za-z0-9._:-`) | `400 idempotency_key_required`                                                             |
| First request                                                   | Runs once; the response is stored with the effect                                          |
| Same key, same request                                          | The stored response again, with header `Idempotent-Replayed: true`; nothing new is created |
| Same key, different request                                     | `422 idempotency_key_reused`                                                               |
| Two identical requests at the same moment                       | The second waits for the first to finish, then replays it                                  |
| First attempt failed (any error)                                | No record is left; a retry with the same key runs again                                    |
| After 24 hours                                                  | The record expires (purged by the worker); the key protects nothing                        |

**Design.** `ops.idempotency_keys` has a unique index on (principal, route, key). `private.idempotency_begin` inserts the record **inside the same database transaction as the business write**; `private.idempotency_complete` stores the response in that transaction. Because the insert blocks on the unique index until the other transaction ends, concurrent duplicates serialise by themselves, and a rolled-back attempt leaves nothing. A deferred constraint refuses a commit that has no stored response. The principal is always `auth.uid()` from the verified claims, never a client-supplied value, so keys are isolated per user (and therefore per tenant). The request fingerprint is the SHA-256 of canonical JSON (sorted keys) of route, path parameters and body.

**Replay and authorisation.** Authentication, MFA and the staff check run **before** replay, so a signed-out or downgraded session cannot read a stored response. Replay returns only what the same person's own earlier request returned.

**What may be stored.** Response bodies are stored verbatim and replayed, so handlers of idempotent routes must not return personal data (today they return ids and statuses). This is a review rule for every new idempotent route.

**Defence in depth.** Domain tables keep their own guards (e.g. `request_change` de-duplicates on requester + key; payment intents are unique per lender + key), so even an expired HTTP record cannot create a second effect.

## 2. Transactional outbox

`ops.outbox_events` holds work to do after a business change. Rows are inserted **by database functions in the same transaction** (today `private.decide_change_request` enqueues `change_request.approved`). If the transaction rolls back, so does the event.

| Column                                     | Meaning                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event_type`, `payload`, `payload_version` | What to do. Payload is a small JSON object of references; a database check refuses keys such as phone, email, name, OTP, PAN, Aadhaar, account number, token, and anything over 4 KB. |
| `correlation_id`, `dedupe_key`             | Tracing; the same business fact enqueued twice yields one event.                                                                                                                      |
| `status`                                   | `pending` → `processing` → `completed`, or `dead` (the dead-letter state).                                                                                                            |
| `attempts`, `max_attempts` (8)             | Counted at claim time.                                                                                                                                                                |
| `available_at`                             | Not before this time (backoff).                                                                                                                                                       |
| `locked_by`, `locked_until`                | The lease (60 s). A worker that dies stops holding it.                                                                                                                                |
| `last_error_code`                          | A short code (`handler_error`, `invalid_payload`, …). Never free text.                                                                                                                |

**Worker (`pnpm --filter @udofin/api worker`).** Claims a batch with `FOR UPDATE SKIP LOCKED` and a lease, validates each payload with a zod schema, runs the handler **outside any database transaction**, then completes the event only if it still holds the lease. Transient errors go back to `pending` with exponential backoff (5 s, 10 s, 20 s … capped at 1 h, ±20 % jitter); unknown types, invalid payloads and permanent errors go straight to `dead`; an event that keeps being abandoned becomes `dead` after its last attempt. Housekeeping purges expired idempotency records and events completed more than 30 days ago.

**Operations.** A `dead` event is an alert: investigate, fix the cause, then `select ops.requeue_dead_event('<id>')`. The worker logs the event id, type and error code (no payload).

**The one handler today.** `change_request.approved` applies the change (`private.apply_change_request`, which re-checks that requester and approver still hold their permissions). Running it twice is harmless: the function refuses a request that is already applied, and the handler treats "already applied" as success.

**Not built (on purpose).** No handlers for SMS, documents, payment providers or reconciliation exist; each arrives with its phase. If a durable worker is not deployed, approved changes stay `approved` until one runs (the API says so in the approve description).

## 3. Tests

`supabase/tests/007_idempotency_outbox.test.sql` (single-connection semantics, privileges, atomic enqueue); `services/api/test/integration/api.integration.test.ts` (real HTTP app, real database, real worker store: concurrent duplicates, retry after failure, key reuse, cross-user and cross-tenant, expiry, duplicate delivery, abandoned worker, concurrent workers, retry limit, safe logging); `services/api/test/outbox-worker.test.ts`, `idempotency.test.ts`.
