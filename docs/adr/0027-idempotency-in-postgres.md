# ADR-0027: Idempotency records in Postgres, in the business transaction

- **Status:** Accepted (13 October 2026, with the Phase 03 implementation)
- **Date:** 2026-10-13
- **Related:** CLAUDE.md rule 4, ADR-0011, ADR-0012; `docs/api/idempotency-and-outbox.md`

## Context

Mobile networks retry, users double-tap, and workers deliver at least once. A state-changing request must not create its effect twice, and "exactly once across external systems" is not achievable. The request and the record that it happened must therefore be inseparable.

## Decision

1. Every state-changing authenticated POST requires an `Idempotency-Key` and stores its result.
2. The record is created and completed **inside the same database transaction as the write**, through two SECURITY DEFINER functions that use `auth.uid()` as the principal.
3. Uniqueness on (principal, route, key) serialises concurrent duplicates without extra locking; a rolled-back attempt leaves no record; a deferred constraint refuses a commit without a stored response.
4. The request fingerprint (SHA-256 of canonical JSON of route, path parameters and body) detects reuse of a key with a different request → `422 idempotency_key_reused`.
5. Records expire after 24 hours and are purged by the worker. Domain tables keep their own natural guards as a second layer.
6. Authentication, MFA and role checks run before replay.
7. Stored responses must not contain personal data (review rule).

## Alternatives considered

| Option                                  | Why rejected                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| In-memory or Redis store                | Not atomic with the write; lost on restart; explicitly ruled out for authoritative idempotency. |
| Store the record after the response     | A crash between commit and store allows a duplicate.                                            |
| Idempotency only via domain constraints | Fine for some tables, but no uniform replay of the original response.                           |

## Consequences

**Positive** — duplicates are impossible by construction for covered routes; behaviour is documented in OpenAPI and testable with real concurrency.
**Negative** — each idempotent request writes one extra row; a long request holds its record's index entry while concurrent duplicates wait.
**Risks** — large or personal response bodies; mitigated by the review rule.

## Verification

pgTAP `007` and the API integration tests (concurrent duplicates, failure then retry, key reuse, cross-user and cross-tenant isolation, expiry, authorisation before replay).

## Revisit triggers

Routes that call external systems inside the request (move the call to the outbox and store a status instead); very high write volume (partition or move hot keys).
