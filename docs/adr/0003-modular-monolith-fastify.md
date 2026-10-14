# ADR-0003: Modular monolith on Fastify 5

- **Status:** Accepted (baseline, pending owner approval)
- **Date:** 2026-10-10
- **Related:** ADR-0002, ADR-0004, ADR-0011, ADR-0012

## Context

- Udofin needs many business capabilities: identity, tenancy, consent, audit, lender configuration and products, applications, verification (KYC orchestration), decisioning integration, offers, documents, servicing sync, payments, mandates, collections, grievance, notifications, integrations (LMS, accounting, ecosystem) and reporting.
- Many operations must be atomic across capabilities. Example: routing a loan request to a lender writes an application, checks consent and records an audit event; these should commit or fail together.
- The team is small. Lenders' IT-outsourcing due diligence will look at how the system is operated, patched and monitored; fewer moving parts are easier to evidence.
- Research recommendation: keep Fastify 5, avoid EKS or microservices at this stage, and do not run financial logic in edge runtimes (`docs/research/2026-10-10/infra-stack.md` §7, §11; interpretation).

## Decision

1. Build the backend as **one deployable modular monolith**: an HTTP API (`services/api`) and, later, a worker entrypoint from the same codebase for background jobs (ADR-0011).
2. Organise code into modules with explicit boundaries, one per capability listed above. A module exposes a small interface; other modules do not reach into its tables or internals.
3. Each data-owning module owns a Postgres schema: `tenancy`, `identity`, `consent`, `audit`, `lending`, `servicing`, `payments` (ADR-0004). New modules add schemas in migrations.
4. Pure business rules live in `packages/domain` (no I/O, frameworks or vendors; lint-enforced). Provider interfaces (ports) and mocks live in `packages/adapters`. Wire formats live in `packages/contracts`.
5. Framework: Fastify 5 with zod-validated configuration.
6. Baseline hardening that every module inherits (already in `services/api/src/`):
   - configuration validated at start-up; the service refuses to start on invalid settings; deployed environments require `DATABASE_URL` and `SUPABASE_URL`; CORS origins may not be `*`, and must be `https://` when deployed (`config.ts`);
   - pino logging with redaction of identity, contact, bank and credential fields and auth headers (`logger.ts`);
   - request ids accepted only if well-formed, otherwise generated (prevents log injection) (`app.ts`);
   - helmet security headers, `cache-control: no-store`, CORS allowlist, rate limiting, 1 MiB body limit;
   - RFC 9457 problem responses that never expose internal errors (ADR-0012);
   - `/health/live` (no dependency checks) and `/health/ready` (dependency checks with a 2 s timeout, names only, no error details);
   - graceful shutdown on SIGTERM/SIGINT (`server.ts`).

## Implementation state

Refreshed on 14 October 2026 (architecture verification, `docs/architecture/phase-02-architecture-verification.md`) against the code. The baseline text above is unchanged; this section says what exists now.

- **Built:** the skeleton and hardening listed in decision 6; JWT verification with `jose` against the project's JWKS (`services/api/src/auth/token-verifier.ts`); the per-request transaction that runs as `authenticated` with the caller's claims (`services/api/src/db/user-context.ts`, ADR-0004, ADR-0032);
  a route registry that validates input and responses with zod, applies authentication, rate limits and idempotency uniformly and generates `docs/api/openapi.json` (`services/api/src/http/routes.ts`); idempotency and the outbox in Postgres (ADR-0027, ADR-0011 as amended).
- **Modules:** nine folders under `services/api/src/modules` (`admin`, `borrower`, `documents`, `health`, `me`, `onboarding`, `panel`, `products`, `routing`). Each is a route file (a few have a small helper) that calls Postgres functions; the business rules live in SQL (ADR-0033). The `service.ts` / `repository.ts` / `index.ts` layout and Kysely
  described in `services/api/src/modules/README.md` were **not** followed and that file is out of date.
- **Entry points from the one codebase:** the HTTP API, the outbox worker (`services/api/src/workers/main.ts`, `pnpm --filter @udofin/api worker`) and a separate lender callback receiver (`services/api/src/workers/callbacks-main.ts`). The receiver is a separate process so that the public API never holds the system database login (ADR-0030, ADR-0032).
- **Schemas** beyond those named in decision 3: `onboarding`, `documents`, `ops` and the `private` helper schema.
- **Module boundaries:** the system database pool may be imported only from `src/system` and `src/workers` (root `eslint.config.mjs`, `services/api/test/boundary.test.ts`), and a lint rule forbids one module importing another. Only the first of the two was in place at the time of the baseline.
- **Still true from the baseline:** rate limiting uses in-process stores, so limits apply per instance (audit F-05; a shared store is needed before more than one instance runs). The unit and integration test counts are in `docs/testing/strategy.md`, not here.
- **Not built:** any deployment (nothing is deployed; `docs/operations/deployment.md`), a production document store, real provider adapters, tracing and metrics ([`observability-spec.md`](../operations/observability-spec.md) is a specification only).

## Alternatives considered

| Option                                                            | Why rejected                                                                                                                                                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Microservices per capability                                      | Distributed transactions and eventual consistency for flows that need atomicity; more deployables to secure, monitor and evidence to lenders; too much operational load for the team (research: hold on microservices/EKS). |
| NestJS                                                            | Adds dependency-injection and decorator weight without a compliance benefit (research interpretation).                                                                                                                      |
| Hono                                                              | Edge-oriented; financial logic should not run in edge runtimes (research: hold).                                                                                                                                            |
| Express 5                                                         | Stable, but a weaker type and plugin story for this use (research interpretation).                                                                                                                                          |
| Fastify 6                                                         | Alpha at research time (research: hold).                                                                                                                                                                                    |
| Supabase Edge Functions or database functions as the main backend | Edge Functions run in the region nearest the caller unless pinned (confirmed, ADR-0010); harder to test and to structure as modules.                                                                                        |

## Consequences

**Positive**

- Cross-module operations can run in one database transaction.
- One build, one deployment, one set of logs and alerts.
- Modules can be split out later if a real need appears, because boundaries are explicit from the start.

**Negative**

- Boundaries are enforced by convention and review until lint rules exist; a hurried change can couple modules.
- One process: a memory leak or crash in one module affects all of them. The API and workers can be scaled only as a whole (per entrypoint).
- Rate limiting uses the in-process store of `@fastify/rate-limit`, so limits apply per instance, not across instances.

**Risks**

- "Big ball of mud" over time. Mitigation: module interfaces, schema ownership, and (planned) ESLint import rules per module.

## Compliance and security notes

- A single deployable simplifies the evidence lenders ask for under IT-outsourcing flow-down (patching, VAPT scope, incident response). Research: likely; primary texts not verified (see the README verification gate).
- Log redaction is a safety net, not the policy: code should not log payloads. Redaction covers listed field names at the top level and up to two levels of nesting (`*.key`, `*.*.key`) only.

## Verification

- `services/api/test/app.test.ts`: health endpoints (liveness without dependencies, readiness, 503 without leaking errors, timeouts), RFC 9457 404, security headers and `no-store`, request-id validation, rate-limit problem response, hidden internal errors.
- `services/api/test/config.test.ts`: safe defaults, deployed environments require database and auth settings, wildcard and plain-http origins rejected, values never echoed in errors.
- `services/api/test/logger.test.ts`: identity, contact and credential fields redacted.

## Revisit triggers

- A module needs independent scaling or availability (for example a high-volume collections dialer).
- A module must run under a different legal entity or regulatory boundary (for example if collections is run by a separate recovery-agent entity).
- Deployment contention between teams becomes a bottleneck.
