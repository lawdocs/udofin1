# Udofin API conventions

Status: working draft, 2026-10-10. Applies to `services/api` (Fastify 5 modular monolith) and to every
client: the borrower app (`apps/mobile`), the portals (`apps/ops-portal`, `apps/lender-portal`), lender
systems and the group's other products. Integration events and the lender LMS connector are specified in
`docs/api/integration-contracts.md`; provider adapters in `docs/integrations/register.md`.

The mobile app and portals never query domain tables directly. The domain schemas are not exposed through
Supabase's REST API (`supabase/migrations/20261010000100_foundation.sql`); every read and write goes
through this API.

> Regulatory statements in this document (data residency, logging) rest on research that could not open
> primary sources (rbi.org.in and others were unreachable; the search budget ran out). They must be
> verified against the primary texts before launch. This is a release gate.

---

## 1. What exists today and what is planned

Updated 13 October 2026 (Phase 03). The machine-readable description of what is implemented is [`openapi.json`](openapi.json) (generated; a test fails if it is stale); the idempotency and outbox design is in [`idempotency-and-outbox.md`](idempotency-and-outbox.md); authentication in [`../auth/README.md`](../auth/README.md).

| Area            | Exists in `services/api` today                                                                                                                                                                                                | Planned                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Routes          | `GET /health/live`, `/health/ready`; `GET /v1/me`; `GET/POST /v1/admin/change-requests`, `GET .../{id}`, `POST .../{id}/approve                                                                                               | reject`; `GET /v1/openapi.json` outside production. Every route is declared once in a registry (`src/http/routes.ts`) | Versioned borrower, lender and ops route groups (§2) |
| Configuration   | zod-validated environment (`src/config.ts`); refuses unsafe values; separate `DATABASE_URL` (user login) and `SYSTEM_DATABASE_URL` (worker login)                                                                             | Adapter mode checks (mock / sandbox / production per environment)                                                     |
| Authentication  | Supabase tokens verified with `jose` against the JWKS (issuer, audience, expiry, asymmetric algorithms only); staff need `aal2`; identity and permissions resolved from the database on every request (`docs/auth/README.md`) | Partner API keys and mTLS                                                                                             |
| Authorisation   | Database role `authenticated` + claims per request (RLS applies); two-person change control for administrative changes; permission matrix test                                                                                | Permission checks per business module                                                                                 |
| Validation      | Request params, query and body validated by zod; responses validated against the declared schema; validation errors name fields and rule codes, never submitted values                                                        | —                                                                                                                     |
| Errors          | RFC 9457 `application/problem+json` with a stable `code` for every error; 5xx bodies never contain internals; database errors mapped to 401/403/404/409/422                                                                   | Full error-code catalogue (§6)                                                                                        |
| Pagination      | Keyset cursor (`limit`, `cursor`, response `nextCursor`) on list routes                                                                                                                                                       | —                                                                                                                     |
| Idempotency     | `Idempotency-Key` required on every state-changing authenticated POST; durable, in the business transaction; replay header `Idempotent-Replayed`                                                                              | Provider-call routes use the outbox with status polling                                                               |
| Background work | Transactional outbox + worker (`pnpm --filter @udofin/api worker`) with leases, backoff, dead state                                                                                                                           | Handlers for notifications, documents, providers, reconciliation                                                      |
| Request id      | `x-request-id` accepted only if it matches `^[A-Za-z0-9-]{8,64}$`, otherwise replaced; echoed in the response header and in `instance`                                                                                        | Correlation id and trace context (§12)                                                                                |
| Headers         | `helmet` security headers, `cache-control: no-store`, CORS allowlist without credentials                                                                                                                                      | —                                                                                                                     |
| Rate limiting   | Global per client IP (`RATE_LIMIT_MAX_PER_MINUTE`); 30 per minute per client on staff write routes                                                                                                                            | Per-principal limits (§9)                                                                                             |
| Body size       | 1 MiB (`bodyLimit`)                                                                                                                                                                                                           | Documents go to object storage, not through JSON                                                                      |
| Logging         | pino with redaction of identity, contact, bank and credential fields (`src/logger.ts`); worker logs ids, types and error codes only                                                                                           | OpenTelemetry to an India-hosted collector                                                                            |
| OpenAPI         | OpenAPI 3.1 generated from the route declarations; contract tests                                                                                                                                                             | Client generation for the apps                                                                                        |
| Tests           | 92 API tests (65 unit/contract + 27 integration against a real database), plus 239 pgTAP assertions and 10 browser tests                                                                                                      | k6 performance tests                                                                                                  |

-------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Routes | `GET /health/live`, `GET /health/ready` only (unversioned, rate-limit exempt) | Versioned routes under `/v1` |
| Configuration | zod-validated environment (`src/config.ts`); refuses to start on unsafe values; deployed environments require `DATABASE_URL` and `SUPABASE_URL`; no wildcard or plain-http CORS origins when deployed | Adapter mode checks (mock / sandbox / production per environment) |
| Authentication | None yet. `jose` is a dependency but not wired | Supabase JWT verification via JWKS; staff MFA; partner API keys and mTLS |
| Authorisation | None yet | Permission checks in the API plus RLS in Postgres (§4) |
| Errors | RFC 9457 `application/problem+json` for 404, 429 and all other errors; 5xx bodies never contain internals (`src/app.ts`) | Stable error-code catalogue (§6); mapping of Fastify and database errors |
| Request id | `x-request-id` accepted only if it matches `^[A-Za-z0-9-]{8,64}$`, otherwise replaced; echoed in the response header and in `instance` | Correlation id and trace context (§12) |
| Headers | `helmet` security headers, `cache-control: no-store` on every response, CORS allowlist without credentials | — |
| Rate limiting | `@fastify/rate-limit`, global, per client IP, `RATE_LIMIT_MAX_PER_MINUTE` (default 120), proxy hops from `TRUST_PROXY_HOPS` | Per-principal and per-route limits (§9) |
| Body size | 1 MiB (`bodyLimit`) | Documents go to object storage, not through JSON |
| Logging | pino with redaction of identity, contact, bank and credential fields (`src/logger.ts`) | OpenTelemetry to an India-hosted collector |
| Idempotency | Database constraint on `payments.payment_intents (lender_org_id, idempotency_key)` | `Idempotency-Key` header handling and store (§7) |
| OpenAPI | None | OpenAPI 3.1 generated from zod (§14) |
| Tests | 14 Vitest tests (`services/api/test/`) | Contract tests per route; RLS tests already in `supabase/tests/` |

---

## 2. Base path, audiences and route groups

- Base path: **`/v1`**. Health endpoints stay at `/health/live` and `/health/ready`, outside versioning.
- Route groups by audience (planned). Each group has its own OpenAPI document and authentication:

| Group                         | Caller                                                              | Authentication                          |
| ----------------------------- | ------------------------------------------------------------------- | --------------------------------------- |
| `/v1/borrower/...`            | Borrower app (and later the borrower web)                           | Supabase access token (borrower)        |
| `/v1/lender/...`              | Lender portal staff                                                 | Supabase access token (staff, MFA)      |
| `/v1/ops/...`                 | Udofin operations and platform administration                       | Supabase access token (staff, MFA)      |
| `/v1/partner/...`             | Lender systems, Finbyx, LawDocsComply, Equator (machine to machine) | API key plus mTLS where agreed (§3.3)   |
| `/v1/webhooks/{provider}/...` | Payment, mandate, eSign and KYC providers                           | Provider signature verification (§11.2) |

---

## 3. Authentication

### 3.1 Borrowers and staff: Supabase access tokens

- Clients send `Authorization: Bearer <access token>` issued by Supabase Auth (phone OTP for borrowers;
  email plus MFA for staff; SAML SSO for staff later, which Supabase supports on Pro and above).
- The API verifies tokens itself with `jose` against the project's JWKS endpoint
  (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`), using asymmetric signing keys (RS256 or ES256),
  as recommended in `docs/research/2026-10-10/infra-stack.md`. No shared JWT secret is configured in the API.
- Checks on every request: signature against a key in the JWKS, algorithm in the allowlist (asymmetric
  only), issuer and audience equal to the configured values for the project (to be read from a real
  project token during implementation), `exp` and `nbf` with at most 30 s clock skew, and `role` equal
  to `authenticated`.
- JWKS is cached in memory and refetched when a token carries an unknown `kid` (rate-limited), so key
  rotation needs no deployment.
- **Token claims are identity, not authority.** The API resolves whether the caller is a borrower or staff,
  and which permissions they hold, from the database on each request (`identity.borrowers`,
  `tenancy.memberships`, `tenancy.role_permissions`). A suspended membership therefore loses access
  immediately, which `supabase/tests/002_tenant_isolation.test.sql` already proves at the database level.
  Claims added by a Custom Access Token hook may be used as hints for the user interface only.
- Failure: `401 unauthenticated` with no detail about which check failed.

### 3.2 Staff MFA

- Every `/v1/lender` and `/v1/ops` route rejects a staff token that does not show a completed second
  factor, with `403 mfa_required`. The exact claim to check must be confirmed against Supabase Auth
  documentation before implementation (not covered by the research).
- Step-up (a fresh second factor within a short window) is required for: approving product versions,
  changing lender credentials or settlement accounts, managing members and roles, and exporting data.
- Staff accounts are created server-side with `app_metadata.actor_type = 'staff'`, so the signup trigger
  does not create a borrower record for them (`private.handle_new_auth_user`).

### 3.3 Partner systems: API keys and mTLS

| Element                   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partner client            | One record per partner system and environment, belonging to one organisation (`tenancy.organizations`), with scopes and an optional IP allowlist.                                                                                                                                                                                                                                                                                                                                                                         |
| API key                   | Sent as `X-Api-Key` (already redacted by the logger). Format: public key id plus at least 32 random bytes of secret. Stored only as a keyed hash; shown once at creation. Expiry at most one year. Two active keys per client for rotation without downtime. Last-used time recorded. Revocation takes effect immediately.                                                                                                                                                                                                |
| mTLS                      | Required for production connections from lender systems and Finbyx where the partner supports it: a client certificate per partner system, with its fingerprint bound to the partner client record. API key and certificate must both match.                                                                                                                                                                                                                                                                              |
| OAuth2 client credentials | Possible replacement for API keys between group products once an authorisation server is chosen (open decision).                                                                                                                                                                                                                                                                                                                                                                                                          |
| Database context          | Proposed: each partner client maps to a service account in `auth.users` created with `app_metadata.actor_type = 'partner'` and a membership in the partner's organisation with an integration role. The API sets that account as the JWT subject for the transaction (§4.2), so RLS applies to partner calls exactly as to staff. Status changes that only `system` may make (for example `disbursement_pending → disbursed`) are never made through a partner call; they happen in the worker after a verified callback. |

### 3.4 Inbound provider webhooks

Provider callbacks (payment gateways, mandate providers, eSign, KYC vendors) are authenticated by the
provider's own signature scheme with a per-lender secret, verified over the raw body before parsing. Where
a provider does not sign callbacks (for example Surepass DigiLocker), the path carries an unguessable
per-request token, the source IP is allowlisted, and the outcome is confirmed by polling the provider
before anything is recorded. See `docs/integrations/register.md` §3.

---

## 4. Authorisation

### 4.1 Two independent layers

1. **API permission check.** Each route declares the permission it needs, using keys from the catalogue in
   `tenancy.permissions` (for example `application.read`, `application.decide`, `product.configure`,
   `product.approve`, `loan.read`, `payment.read`, `audit.read`, `org.members.manage`,
   `platform.organizations.manage`). The API checks the caller holds it in the organisation that owns the
   resource. Borrower routes check ownership.
2. **Row Level Security.** The same request runs in Postgres as the `authenticated` role with the caller's
   claims, so every policy in `supabase/migrations/` applies again. A bug in layer 1 cannot expose another
   lender's rows.

Platform (Udofin) staff can read a lender's data only through permissions marked `platform_grantable`.
The API writes an audit event for every such access (for example action
`platform_access.application.read`, with the lender as `tenant_org_id`). Denied attempts are audited with
outcome `denied`.

Resources outside the caller's scope return `404 not_found`, so their existence is not revealed. A
resource the caller can see but not change returns `403 forbidden`.

### 4.2 How a request runs in the database

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims', $1, true);           -- {"sub": "<auth user id>", "role": "authenticated"}
select set_config('udofin.transition_reason', $2, true);     -- only when changing an application's status
-- domain queries and writes (RLS applies)
select private.record_audit_event($action, $entity_type, $entity_id, $tenant_org_id,
                                  'success', $metadata, $request_id, $correlation_id);
commit;
```

- `SET LOCAL` and `set_config(..., true)` last only for the transaction, so they are safe through a
  transaction-mode pooler (interpretation in `infra-stack.md`; prepared statements must be disabled when
  using Supavisor transaction mode).
- `private.record_audit_event` derives the actor from the session; callers cannot forge it.
- `udofin.transition_reason` is recorded in `lending.application_events.reason` by the lifecycle trigger.
  Reasons are short codes or staff-written text without borrower personal data.
- The service role (which bypasses RLS) is used only in worker code paths (provider callbacks, LMS sync,
  scheduled jobs), never in request handlers. Each such job writes its own audit rows with
  `actor_type = 'system'`.

---

## 5. Request and response format

| Item            | Convention                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Media type      | `application/json; charset=utf-8` for requests and responses; errors use `application/problem+json`.                                                                                                                           |
| Field names     | `camelCase` in JSON. Database columns stay `snake_case`.                                                                                                                                                                       |
| Identifiers     | UUID strings. Udofin generates time-ordered version 7 UUIDs (`private.uuid_v7()`).                                                                                                                                             |
| Money           | `MoneyMinor` from `packages/contracts`: `{ "minor": "125050", "currency": "INR" }`, integer paise as a string. Never floating point.                                                                                           |
| Rates           | Integer basis points, e.g. `aprBps: 2450` (24.50%), matching `*_bps` columns.                                                                                                                                                  |
| Timestamps      | RFC 3339 with an explicit offset (`Timestamp` in `packages/contracts`). The API emits UTC (`Z`); clients may send any offset; local times without an offset are rejected.                                                      |
| Dates           | `YYYY-MM-DD` for calendar dates such as instalment due dates.                                                                                                                                                                  |
| Enumerations    | Lowercase `snake_case` strings, identical to database enum values (e.g. application status `under_review`).                                                                                                                    |
| Unknown fields  | Rejected on write requests (`400 validation_failed`). Clients must ignore unknown fields in responses.                                                                                                                         |
| Absent values   | Optional fields are omitted when unknown; `null` appears only where the schema says so.                                                                                                                                        |
| Single resource | The resource object.                                                                                                                                                                                                           |
| Lists           | `{ "data": [ ... ], "page": { "nextCursor": "…" or null, "limit": 25 } }` (§8).                                                                                                                                                |
| Language        | `Accept-Language` selects borrower-facing text; consent notices are versioned per language in `consent.notices`.                                                                                                               |
| Files           | Never in JSON. Uploads and downloads use short-lived pre-signed URLs to S3 in ap-south-1, issued by the API after authorisation (Phase 07). Supabase Storage signed URLs are not used for KYC or loan documents (CDN caching). |

---

## 6. Errors (RFC 9457)

Every error is a `ProblemDetails` object (`packages/contracts/src/http/problem.ts`): `type`, `title`,
`status`, optional `detail`, `instance` (the request id), a stable machine-readable `code`
(`^[a-z][a-z0-9_]*$`) and optional `errors[]` with `path` and `message` for field validation. `type`
is `about:blank` today; clients must branch on `code`, not on `type` or `title`.

`detail` and `errors[].message` are written for the caller and never contain stack traces, SQL,
constraint names, provider responses, or any submitted value.

### 6.1 Code catalogue

| Code                              | HTTP | Meaning                                                                       | In code today                |
| --------------------------------- | ---- | ----------------------------------------------------------------------------- | ---------------------------- |
| `bad_request`                     | 400  | Generic client error (fallback; to be replaced by specific codes)             | Yes (fallback)               |
| `validation_failed`               | 400  | Body, query or path failed schema validation; see `errors[]`                  | Planned                      |
| `idempotency_key_required`        | 400  | Endpoint requires `Idempotency-Key` and none was sent                         | Planned                      |
| `invalid_cursor`                  | 400  | Cursor malformed, expired or used with different filters                      | Planned                      |
| `unauthenticated`                 | 401  | Missing, invalid or expired token or API key                                  | Planned                      |
| `webhook_signature_invalid`       | 401  | Inbound webhook signature or timestamp check failed                           | Planned                      |
| `forbidden`                       | 403  | Caller lacks the permission for this action                                   | Planned                      |
| `mfa_required`                    | 403  | Staff route without a completed second factor, or step-up needed              | Planned                      |
| `consent_required`                | 403  | The borrower has not granted (or has withdrawn) the consent this action needs | Planned                      |
| `not_found`                       | 404  | Route or resource does not exist, or is outside the caller's scope            | Yes                          |
| `conflict`                        | 409  | Uniqueness or concurrency conflict                                            | Planned                      |
| `invalid_state_transition`        | 409  | Lifecycle does not allow this change, or the record is immutable              | Planned                      |
| `offer_expired`                   | 409  | Offer validity has passed                                                     | Planned                      |
| `idempotency_key_reused`          | 409  | Same key, different request body                                              | Planned                      |
| `idempotency_request_in_progress` | 409  | Same key, first request still running; retry after `Retry-After`              | Planned                      |
| `payload_too_large`               | 413  | Body over 1 MiB                                                               | Planned (Fastify code today) |
| `unsupported_media_type`          | 415  | Not JSON                                                                      | Planned (Fastify code today) |
| `business_rule_violation`         | 422  | A domain rule failed (e.g. tenure below the category floor)                   | Planned                      |
| `app_version_unsupported`         | 426  | Mobile app version below the minimum supported                                | Planned                      |
| `rate_limited`                    | 429  | Too many requests                                                             | Yes                          |
| `internal_error`                  | 500  | Unexpected failure; details only in server logs                               | Yes                          |
| `service_unavailable`             | 503  | API not ready (dependency down)                                               | Planned                      |
| `upstream_unavailable`            | 503  | Provider unavailable or its circuit is open                                   | Planned                      |
| `upstream_timeout`                | 504  | Provider did not answer in time; outcome may be unknown                       | Planned                      |

New codes may be added in a minor change; clients must handle an unknown code by its HTTP status.

Implemented authentication codes (all `401`, problem+json): `token_missing`, `token_invalid` (malformed token, a
`session_id` that is not a UUID, or, when deployed, no `session_id` at all) and `token_expired`; `mfa_required`
(staff without the second factor); and `session_revoked` (14 October 2026, audit F-01): the token was valid but
its session has ended through sign-out, revocation or the session time-box, so the client must sign in again. The mobile app
reacts to any `401` by refreshing once and then signing out; the portals treat a `401` from `/v1/me` as signed out.

### 6.2 Mapping database errors

The database is the last line of defence. The API checks preconditions first (using the state machines in
`packages/domain`) so that most errors get a specific code; database errors map as follows:

| SQLSTATE (source)                                                                      | Response                                                        |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `42501` insufficient privilege (RLS, actor checks in triggers)                         | `403 forbidden`, or `404 not_found` if the row is not visible   |
| `23505` unique violation                                                               | `409 conflict` (or idempotent replay for `payment_intents`, §7) |
| `23514` check violation (including trigger checks such as tenure floor, maker-checker) | `422 business_rule_violation`                                   |
| `23503` foreign key violation                                                          | `422 business_rule_violation`                                   |
| `P0001` raised by triggers (immutability, disallowed transitions, expired offer)       | `409 invalid_state_transition`                                  |

---

## 7. Idempotency-Key for financial and legally significant POSTs

**Required** (`400 idempotency_key_required` without it) on every POST that creates or changes a payment
intent, mandate, disbursement instruction, offer acceptance or decline, application submission, consent
capture, eSign or eStamp request, lender decision or offer issue, and partner payment advice (the
financial POSTs listed in ADR-0012, plus legally significant ones). Honoured on all other POSTs if sent.

| Aspect                             | Rule                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format                             | `Idempotency-Key` header, 16 to 128 characters from `[A-Za-z0-9_-]` (the database accepts 16–128 characters in `payment_intents.idempotency_key`). A UUID is recommended. Never derived from personal data.                                                                                                                                                               |
| Scope                              | (authenticated principal, HTTP method, route template, key).                                                                                                                                                                                                                                                                                                              |
| Fingerprint                        | SHA-256 of the method, route template and canonical JSON body (sorted keys).                                                                                                                                                                                                                                                                                              |
| Storage                            | A Postgres table in a non-exposed schema (planned, Phase 03): scope, key, fingerprint, state (`in_progress`, `completed`), response status, response body, created and expiry times. The record is written in the **same transaction** as the business change, so a rolled-back request leaves no record. Response bodies containing personal data are encrypted at rest. |
| Retention                          | At least 24 hours after completion. Resources with their own idempotency column (`payments.payment_intents`) are de-duplicated permanently by the database constraint.                                                                                                                                                                                                    |
| Same key, same body, completed     | The stored status and body are returned with header `Idempotent-Replayed: true`.                                                                                                                                                                                                                                                                                          |
| Same key, same body, still running | `409 idempotency_request_in_progress` with `Retry-After`.                                                                                                                                                                                                                                                                                                                 |
| Same key, different body           | `409 idempotency_key_reused`. The original request is not described.                                                                                                                                                                                                                                                                                                      |
| What is stored                     | 2xx results and business outcomes (409, 422). Not stored: 5xx, 429, 401, 403; the transaction rolled back and the client may retry with the same key.                                                                                                                                                                                                                     |
| After expiry                       | The key is treated as new. Clients must never reuse a key for a different operation.                                                                                                                                                                                                                                                                                      |
| Provider calls                     | Never made inside the request transaction. The request records the intent and an outbox job in one transaction; the job calls the provider with an idempotency key derived from the Udofin resource id (`docs/integrations/register.md` §3.1).                                                                                                                            |

**Known gap:** `payments.payment_intents` makes the key unique per **lender**, while the API scopes keys per
**principal**. If a stored intent with the same lender and key belongs to a different borrower, the API
must answer `409 idempotency_key_reused` without revealing the other intent. Consider making the stored key
`hash(principal id, client key)` when the payments endpoints are built.

---

## 8. Pagination

- Cursor-based. Query parameters: `limit` (1–100, default 25) and `cursor` (opaque string from the
  previous page). Offset pagination is not offered.
- Default order is newest first by `id` (UUID v7, so time-ordered), with `id` as the tie-breaker for any
  other sort key.
- `page.nextCursor` is `null` on the last page. No total counts by default.
- The cursor encodes only the sort key and id, never personal data. A cursor is valid only with the same
  filters; otherwise `400 invalid_cursor`.
- Partner change feeds use ascending order with an `updatedSince` filter so that a consumer can resume
  from its last cursor.

---

## 9. Rate limits

- **Today (updated 14 October 2026, audit R-02):**
  - **Per client address, before authentication:** `RATE_LIMIT_MAX_PER_MINUTE` (default 120 per minute) for
    every route, with a tighter limit on some routes (for example 60 per minute on borrower writes, 8 per
    10 minutes on step-up). Health endpoints are exempt.
  - **Per verified principal, after authentication:** `RATE_LIMIT_PRINCIPAL_MAX_PER_MINUTE` (default 600
    per minute) across all authenticated routes, and every route that declares its own limit is also
    limited per principal with the same numbers. The key is the token's verified user id (after signature,
    expiry and session checks), falling back to the address when no principal was recorded. A requester who
    rotates addresses, or many borrowers behind one carrier address, are therefore treated separately.
    Requests that fail authentication are not counted against any principal.
  - **Client address resolution:** `TRUST_PROXY_HOPS` is the number of trusted reverse-proxy hops in front
    of the API. It is **required** when `APP_ENV` is `staging` or `production` (the API refuses to start
    without it; `0` is accepted only as a deliberate statement that the API is directly exposed). It defaults
    to `0` in `local` and `test`. A wrong value makes every client share one bucket (too low) or lets a
    client choose its own address (too high): set it to the number of proxies you operate and check it with
    a request through the real load balancer.
  - Exceeding a limit returns `429 rate_limited` with `Retry-After`. All counters are kept inside each API
    process (the plugin's in-memory store), so with several instances the effective limits multiply; a
    shared store is needed before relying on them as a hard control when scaling out.
- **Planned:**
  - tighter limits on sensitive routes: offer acceptance, payment intent creation, consent capture, ops
    borrower search, partner bulk reads;
  - per-lender limits on partner routes so one lender cannot starve another;
  - `Retry-After` on every 429.
- Login OTP throttling sits in Supabase Auth and the Send SMS hook, not in this API.

---

## 10. Versioning and deprecation

| Topic                               | Rule                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Major version                       | In the path (`/v1`). Only breaking changes create `/v2`.                                                                                                                                                                                                                                                                                                                                                         |
| Non-breaking (allowed within `/v1`) | New endpoints; new optional request fields; new response fields; new error codes; new values in enums documented as open.                                                                                                                                                                                                                                                                                        |
| Breaking (needs a new major)        | Removing or renaming a field; changing a type, unit or meaning; making an optional field required; tightening validation on an existing field; changing default order or pagination; removing an enum value.                                                                                                                                                                                                     |
| Parallel run                        | A new major runs alongside the old one. Both are generated from zod schemas and tested.                                                                                                                                                                                                                                                                                                                          |
| Deprecation                         | Announced in the changelog for each audience. Deprecated endpoints return `Deprecation` and `Sunset` response headers. Minimum notice before removal: 6 months for partner routes; for mobile routes, until the minimum supported app version no longer uses them.                                                                                                                                               |
| Mobile                              | The app sends its version and platform with each request (header to be fixed with the first `/v1` route). The API enforces a minimum supported version with `426 app_version_unsupported` and a store link. Over-the-air updates are disabled (`apps/mobile/app.config.ts`), so every app change is a store release; legal text, consent wording and loan terms are served by the API, versioned, never bundled. |
| Events                              | Versioned by type name (`…v1`, `…v2`); see `docs/api/integration-contracts.md` §7.                                                                                                                                                                                                                                                                                                                               |

---

## 11. Webhooks

### 11.1 Webhooks sent by Udofin

| Element         | Rule                                                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body            | One CloudEvents envelope (`EventEnvelope`, `packages/contracts/src/events/envelope.ts`), `Content-Type: application/cloudevents+json; charset=utf-8`.                                                                                         |
| Headers         | `webhook-id` (equals the envelope `id`), `webhook-timestamp` (Unix seconds), `webhook-signature`. This follows the Standard Webhooks scheme that Supabase Auth hooks also use.                                                                |
| Signature       | `v1,` followed by base64 HMAC-SHA256, keyed with the subscription secret, over `{webhook-id}.{webhook-timestamp}.{raw body}`. During rotation the header carries one signature per active secret, space-separated.                            |
| Secret          | At least 32 random bytes, `whsec_` prefix, one per subscription, held in the secrets manager, at most two active at once.                                                                                                                     |
| Receiver checks | Verify over the raw bytes before parsing; constant-time comparison; reject if `webhook-timestamp` is more than **300 seconds** from the receiver's clock (replay window); then de-duplicate on (`source`, `id`).                              |
| Delivery        | At least once. 2xx within 10 s means accepted. Retries with exponential backoff for up to 24 hours, then the delivery is parked in a dead-letter queue and the subscriber's administrator is alerted. HTTPS only; redirects are not followed. |
| Scope           | A lender's subscription receives only events whose `tenantid` is that lender.                                                                                                                                                                 |
| Replay          | `GET /v1/partner/events?after=<cursor>` returns events the subscriber is entitled to, for recovery after an outage (planned).                                                                                                                 |

### 11.2 Webhooks received by Udofin

- Verified with the provider's own scheme and the per-lender secret; outcome recorded in
  `payments.provider_events` (or the equivalent table for other ports) with `signature_verified`, a SHA-256
  of the payload and de-duplication on (`provider`, `provider_event_id`). Raw payloads are not stored
  because they can contain personal data.
- The handler stores and acknowledges quickly; processing happens in the worker.
- Unsigned callbacks are hints only and must be confirmed by a status poll.
- **Signature before anything else (implemented 14 October 2026).** The Supabase Send-SMS hook verifies the
  Standard Webhooks signature over the raw bytes **before** the body schema is applied and before any
  database work, so an unsigned caller always gets `401` and learns nothing about the body rules.
- **Replay protection across instances (audit F-06).** After a valid signature and a valid body, the message
  id is recorded in `ops.seen_webhooks` through `private.mark_webhook_seen(source, id)`; a second delivery
  of the same id on any API instance gets `401 replayed`. The call runs on the API's normal login as role
  `authenticated` **without end-user claims** (the public API process never holds the system login), and
  the function refuses any call that carries a user identity. If the database cannot be reached the hook
  answers `503 dedup_unavailable` and sends nothing (fail closed; Supabase retries). Rows hold the id only,
  and the worker deletes rows older than one day. Without a database (a single local process) the old
  per-process cache is the fallback.
- **Lender callback receiver (audit F-03).** Every outcome before the signature is verified, whether the
  lender id is unknown, inactive, manual or `api` kind, the id or the headers are malformed, or our own
  configuration is incomplete, is the same `401 invalid_signature` problem response, so lender ids cannot
  be enumerated. The real reason is written to the server log only (a validated lender id and a reason
  code, never headers, bodies or secrets). After a valid signature, a body that fails validation is `422`.

---

## 12. Request ids and correlation ids

| Header             | Purpose                                                                                                                                                                                                                                                                                                                 | Status  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `x-request-id`     | One per HTTP request. Accepted from the caller only if it matches `^[A-Za-z0-9-]{8,64}$`, otherwise a random UUID is used (prevents log injection). Echoed in the response and in the problem `instance`. Stored in `audit.events.request_id`.                                                                          | Exists  |
| `x-correlation-id` | One UUID per business operation across services. Accepted from authenticated Udofin clients and partner systems, otherwise generated. Copied into event `correlationid`, `audit.events.correlation_id`, outbound provider calls where supported, and logs. Events caused by another event or command set `causationid`. | Planned |
| `traceparent`      | W3C trace context for OpenTelemetry, exported to an India-hosted collector.                                                                                                                                                                                                                                             | Planned |

---

## 13. Personal data rules

1. **Never in URLs.** No phone number, email, PAN, Aadhaar number or VID, account number, UPI id, name,
   date of birth, address or OTP in a path or query string. URLs are logged by the API, proxies and load
   balancers, and kept in browser history. Look-ups by such values use `POST` with a JSON body (for
   example an operations borrower search).
2. **Never in logs.** Handlers do not log request or response bodies. The pino redaction list in
   `services/api/src/logger.ts` (PAN, Aadhaar, VID, CKYC number, OTP, PIN, phone, mobile, email, date of
   birth, account numbers, UPI id/VPA, address, full name, tokens, secrets, credential headers) is a
   safety net, not the policy.
3. **Never in error messages**, event `subject`s, identifiers, idempotency keys, cursors, webhook URLs,
   push payloads or metric labels.
4. **Minimal responses.** Borrower routes return only the borrower's own data. Identifiers are masked
   where shown. Restricted data (KYC artefacts, bureau data) is not returned by general routes at all; it
   stays in the lender's vault.
5. **No caching.** `cache-control: no-store` on every response (exists).
6. **Classification.** Every schema field will carry a classification (`public`, `internal`,
   `confidential`, `restricted`, as in `DataClassification`) in its zod metadata, used for documentation,
   logging rules and export checks.
7. **Residency.** Request processing, logs and traces stay in India in production (see `infra-stack.md`;
   regulatory basis to be verified against the primary texts).

---

## 14. OpenAPI 3.1 from zod

- Request and response schemas are zod 4 schemas. Shared wire types (`MoneyMinor`, `Timestamp`, `Uuid`,
  `DataClassification`, `ProblemDetails`, `EventEnvelope`) live in `packages/contracts`; route-specific
  schemas live with their module.
- Fastify validates and serialises with the zod schemas (`fastify-type-provider-zod`), and
  `@fastify/swagger` emits OpenAPI 3.1 (package compatibility recorded in `infra-stack.md`).
- One document per audience (§2). The partner document is published to partners; borrower, lender and ops
  documents are internal.
- CI generates the documents, lints them and compares them with the last released version; a breaking
  difference fails the build unless the change is on a new major version.
- Events are documented from the same zod schemas (AsyncAPI 3.0 is the suggested format).
- tRPC is not used for partner APIs.

---

## 15. Gaps in the current code found while writing this

1. The error handler passes Fastify's own error codes through in lower case, so codes such as Fastify's
   media-type code still reach clients; map them to §6.1. Since 14 October 2026 the title and detail of 4xx
   answers are fixed text per status (never the framework's message, which can echo request fragments).
2. JWT verification, route permissions and the per-request database transaction are not implemented yet.
3. Rate-limit counters are per process (§9). Per-principal limits exist since 14 October 2026.
4. `private.record_audit_event` requires an authenticated user and labels every non-borrower as `staff`;
   `audit.actor_type` has a `partner` value that nothing sets yet. Partner and system audit paths need
   a migration (§3.3, §4.2).
5. Payment-intent idempotency scope differs between the database and the API (§7).
