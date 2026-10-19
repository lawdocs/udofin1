# ADR-0012: API and event contracts

- **Status:** Accepted (baseline, pending owner approval) — partly implemented; see Implementation state
- **Date:** 2026-10-10
- **Related:** ADR-0003, ADR-0008, ADR-0011, ADR-0024

## Context

- Udofin's API serves the borrower app, two portals, partner lenders, providers (payments, KYC, eSign) and sister products (Finbyx, LawDocsComply, Equator). External parties need stable, documented contracts.
- Financial requests are retried by clients and networks; a retry must never create a second payment or offer.
- Money must be exact on the wire; JSON numbers cannot represent all 64-bit integers.
- Errors must help callers without leaking internals or personal data.
- Research recommendation: OpenAPI 3.1 with zod 4 as the source; versioned paths; idempotency keys; Standard Webhooks-style signed callbacks; CloudEvents 1.0 envelopes; tRPC at most for internal portals (`docs/research/2026-10-10/infra-stack.md` §9, interpretation). `@fastify/swagger` can emit OpenAPI 3.1.0 or 3.2.0 and `fastify-type-provider-zod` targets zod 4 (confirmed).
- Some provider webhooks are unsigned (Surepass DigiLocker callback; confirmed gap in `providers-payments.md` §1).

## Decision

**HTTP API**

1. REST over HTTPS. Paths versioned as `/v1/...`; a breaking change needs a new major version.
2. Request and response schemas are zod schemas; OpenAPI 3.1 is **generated** from them, not hand-written.
3. Errors use RFC 9457 `application/problem+json` (`ProblemDetails` in `packages/contracts/src/http/problem.ts`): `title`, `status`, a stable machine-readable `code`, `instance` = request id, optional field `errors`. Server errors never include stack traces, SQL, provider responses or personal data.
4. Every financial POST (payments, mandates, offers, disbursement instructions) requires an `Idempotency-Key` header (16–128 characters); a retry with the same key returns the original result. The database backs this with unique keys (e.g. `payment_intents (lender_org_id, idempotency_key)`).
5. Cursor pagination for lists; rate limits on all routes except health checks; `x-request-id` echoed when well-formed.
6. Wire primitives (`packages/contracts/src/primitives.ts`): UUIDs; RFC 3339 timestamps with explicit offset; money as `MoneyMinor` `{ minor: "<integer paise as string>", currency: "INR" }`; a `DataClassification` label (`public`, `internal`, `confidential`, `restricted`).
7. tRPC is not used for partner or ecosystem APIs.

**Events and webhooks** 8. Integration events use a CloudEvents 1.0 structured-JSON envelope (`packages/contracts/src/events/envelope.ts`) with extensions `tenantid` (lender; absent only for platform events), `correlationid`, `causationid` and `dataclassification`. `subject` is an aggregate id, never a PAN, Aadhaar number or phone number. 9. Event type naming: `in.<product>.<aggregate>.<fact>.v<major>`, product one of `udofin`, `finbyx`, `lawdocscomply`, `equator`. A breaking payload change gets a new major; producers publish both versions until consumers migrate. Consumers de-duplicate on `(source, id)`. 10. Outbound webhooks are signed (HMAC over a timestamp and the body, with a replay window), retried, and de-duplicated by receivers. 11. Inbound webhooks: verify the signature, store only a payload hash and normalised fields, de-duplicate on `(provider, provider_event_id)` (`payments.provider_events`). Where a provider does not sign webhooks, treat them as hints and poll the provider's status API as the source of truth.

## Implementation state

| Item                                                                            | State                              |
| ------------------------------------------------------------------------------- | ---------------------------------- |
| RFC 9457 errors, request ids, rate limits, `no-store`                           | Done (`services/api/src/app.ts`)   |
| ProblemDetails, MoneyMinor, Uuid, Timestamp, DataClassification, EventEnvelope  | Done (`packages/contracts`)        |
| Database idempotency and webhook de-duplication                                 | Done (migration 0500)              |
| `/v1` routes, OpenAPI generation, `Idempotency-Key` handling, cursor pagination | Not built (no business routes yet) |
| Webhook signing and verification                                                | Not built                          |

## Alternatives considered

| Option                                  | Why rejected                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| tRPC for all clients                    | Ties clients to TypeScript and the server's internal types; unsuitable for external partners (research). |
| Hand-written OpenAPI                    | Drifts from validation code.                                                                             |
| Ad hoc error bodies                     | Every client parses errors differently; easy to leak internals.                                          |
| Money as JSON numbers or decimal rupees | Precision loss beyond 2^53; rounding ambiguity.                                                          |
| Bespoke event envelope                  | CloudEvents is a published standard partners may already support.                                        |

## Consequences

**Positive**

- Partners get generated, versioned documentation; validation and documentation cannot disagree.
- Retries are safe for money-moving calls.
- Events carry tenant, correlation and sensitivity metadata needed for routing, audit and handling.

**Negative**

- Maintaining two major versions during migrations costs effort.
- Clients must handle money as strings and convert carefully.

**Risks**

- 4xx responses include Fastify's error message as `detail`; validation messages must never echo submitted personal data.
- `ProblemDetails.type` is always `about:blank` today; specific problem type URIs may be needed for partners.

## Compliance and security notes

- Idempotency and signed, de-duplicated webhooks are controls against duplicate or forged money movements (ADR-0008). The `dataclassification` label supports data-handling rules in ADR-0009. No regulatory text mandates these formats.

## Verification

- `services/api/test/app.test.ts`: unknown routes return RFC 9457 problem details; internal error details are hidden; rate limiting returns a problem response; malformed request ids are replaced.
- `packages/contracts/src/events/envelope.test.ts`: well-formed envelopes accepted; timestamps without offset rejected; classification label required. `packages/contracts/src/primitives.test.ts`.
- `supabase/tests/003_lifecycle_and_integrity.test.sql`: replayed idempotency key and replayed provider webhook rejected (`23505`).
- Planned: a contract test that the generated OpenAPI document matches the registered routes; webhook signature and replay-window tests.

## Revisit triggers

- A partner lender or sister product requires a different standard (for example AsyncAPI documentation, mTLS, or a lender-specific API format).
- The first breaking change to a published contract.
