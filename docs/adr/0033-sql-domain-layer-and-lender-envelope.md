# ADR-0033: SQL functions are the domain layer; a lender-neutral integration envelope

- **Status:** Proposed. Part A records what the code already does and needs the owner's approval as a rule. Part B is a **proposed contract that is not implemented**: no real lender integration exists, and the first lender's signature scheme (D-43) is undecided.
- **Date:** 2026-10-14
- **Related:** ADR-0003, ADR-0004 (amendment of 14 October 2026), ADR-0007, ADR-0012, ADR-0015, ADR-0027, ADR-0030, ADR-0032; `docs/architecture/phase-02-architecture-verification.md` (register items D and M); `docs/api/integration-contracts.md`

## Context

Two questions came out of the architecture verification, and they are one question seen from two sides: **through what single door does anything change state?**

- **Inside the system.** ADR-0003 describes modules with services and repositories. The code does not look like that. Each API module is a route file that validates input and calls Postgres functions; the rules
  (eligibility windows, consent checks, lifecycle steps, maker-checker, KFS validation) live in `SECURITY DEFINER` functions and triggers. `packages/domain` holds only pure helpers (money, state-machine declarations)
  and a mirror of the application lifecycle. This works and is well tested, but it is an unwritten rule, and a reader of ADR-0003 would expect something else.
- **At the edge.** Lender systems will eventually send messages (acknowledgements, checks, decisions, offers) and receive applications. ADR-0030 already routes manual portal entry and signed callbacks through the same
  private `apply_*` functions, so the rules cannot diverge. What is missing is the **agreed shape of the message**, so that each lender is configuration, not code. The verification recommended approving a neutral contract before the first real lender,
  rather than letting the first lender's API shape the system.

## Decision, part A: SQL functions are the domain layer

1. **Business rules live in the database.** A state change that the business cares about (a lifecycle step, a consent record, a routing, an offer, an acceptance, an approval, a requeue) is made by a Postgres function or
   a guarded insert under row level security, and by nothing else. Triggers and constraints back the functions; they are not a substitute for them.
2. **Function conventions** (every new function): `SECURITY DEFINER` only where it must be, with `set search_path = ''` and fully qualified names; `EXECUTE` revoked from `PUBLIC` and `anon` and granted to named roles;
   the caller derived inside the function (`private.current_actor()`, `private.my_borrower_id()`, `private.invoking_role()`), never taken from an argument; stable SQLSTATE codes that the API maps to problem codes (RFC 9457);
   audit written in the same transaction; idempotent where a retry is possible; no personal data in errors, audit metadata or outbox payloads; a `comment on function` that says what it guarantees.
3. **API routes stay thin.** A route validates input and output with zod, authenticates, checks the caller may attempt the operation, and calls the function. It does not re-implement a rule that exists in SQL, and it does
   not build SQL from request data: queries use bound parameters through `pg`. Small read projections may sit in a route; anything that decides or changes state does not.
4. **`packages/domain` is for pure code that more than one runtime needs** (money in integer paise, state-machine declarations, the application lifecycle). Where a lifecycle is declared both in SQL and in TypeScript there is a test
   that fails if they diverge (`packages/domain/test/lifecycle-sync.test.ts` for the application lifecycle). Do not add a TypeScript copy of a SQL lifecycle unless a client needs it, and never without such a test.
5. **Tests follow the layer.** Each function has pgTAP tests (allowed, refused, wrong tenant, wrong role, repeated call), an entry in the authorisation matrix, and, where it is reachable over HTTP, an integration test
   through the real application against a real migrated database.
6. **No ORM or query builder by default** (ADR-0004 amendment). Typed access is a thin handle (`UserTx`) over `pg`; a generated-types or query-builder dependency needs its own decision.
7. **Module boundaries** are route files plus naming, enforced by a lint rule that forbids a module importing a sibling (shared helpers live in `src/db`, `src/http`, `src/auth`).

## Decision, part B (proposed contract): the lender-neutral integration envelope

A lender is reached through **one message shape in each direction**. Differences between lenders are data (connector kind, endpoint, secret reference, capabilities, mappings), never branches in code.

**Inbound (lender to Udofin).** A JSON object with exactly these members:

| Member       | Meaning                                                                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messageId`  | Unique per message, chosen by the lender; 8 to 100 characters of `A-Za-z0-9._:-` (the shape `lending.inbound_messages.message_id` already enforces). Identifies the message for idempotency. |
| `lenderId`   | The lender's organisation id **as issued by Udofin**. It selects the verification key; it does not confer authority (ADR-0032 point 5).                                                      |
| `type`       | What happened, from a closed, versioned list (today `ack`, `check`, `decision`, `offer`, `offer_withdrawn`). An unknown type is refused, not ignored.                                        |
| `occurredAt` | When it happened on the lender's side, RFC 3339 with an offset. Informational: Udofin records its own receipt time and never lets this field move a deadline.                                |
| `payload`    | The per-type body, validated by a published schema. It carries the correlation reference Udofin sent when the application was submitted. No personal data beyond what the type needs.        |

Rules:

1. **Per-lender signature, verified first.** The message carries a signature over the exact bytes received (timestamp and message id included, replay window of minutes), made with a key or secret that belongs to that lender and is referenced by name in the lender's record.
   The receiver verifies it **before** the database sees anything. The scheme per lender (symmetric HMAC as the labelled mock scheme does today, or asymmetric) is decided with the first lender (D-43). Keys rotate with an overlap period.
2. **Uniform refusal.** Anything that fails before the signature is verified (unknown or inactive lender, malformed id, missing header, our own configuration gap) looks identical from outside (except body-parser errors, which come first), so lender ids cannot be enumerated.
3. **Idempotent inbound, keyed by `(lenderId, messageId)`.** The first copy is applied; a repeat returns the first result and changes nothing. Rejected and quarantined messages are recorded with a reason class and no body. Ordering is **not** guaranteed;
   the apply functions must accept messages in any order or hold them.
4. **One entry point.** The receiver and the lender portal's manual entry call the same private `apply_*` functions (ADR-0030, decision 5). A lender without an API uses the portal and needs no connector.
5. **Unknown fields are refused**, so a lender cannot smuggle data into a record by adding members.

**Outbound (Udofin to lender).**

1. **Push the fixed minimum payload** (`minimum_payload_v1`) only after consent for that lender is re-validated inside the database in the same transaction (ADR-0030), with a stable correlation reference per application that the lender can use to recognise a retry.
2. **A timeout is not a rejection.** An uncertain send is recorded as uncertain and **reconciled by a status lookup** (`lookup(correlationRef)`), on a back-off schedule, before any resend. Udofin never blindly resends.
3. **Status lookup** is a read-only, authenticated call the lender implements, answering found, not found or unknown. It is also the reconciliation path if callbacks are lost.

**Out of scope here:** the lender LMS connector for loan accounts, schedules and receipts (`docs/api/integration-contracts.md` section 4; Phase 08); Finbyx-specific behaviour; provider integrations (KYC, bureau, payments, signing).

**Relation to ADR-0012.** ADR-0012 sets CloudEvents 1.0 for integration events between the group's products. The five members above map one to one onto CloudEvents attributes (`id`, a source naming the lender, `type`, `time`, `data`, with the lender id as the tenant extension), which is why they were chosen.
Whether the lender wire format **is** a CloudEvents profile or a plain JSON object with these names is an open point for the owner; `docs/api/integration-contracts.md` describes LMS callbacks as signed CloudEvents, so the two documents must be reconciled when this ADR is accepted.

## Implementation state

Part A: the existing practice. Nine API modules are route files (`services/api/src/modules/*/routes.ts`) calling functions in the `onboarding`, `lending`, `consent`, `identity`, `documents`, `ops` and `tenancy` schemas;
`services/api/src/http/routes.ts` is the route registry; the lint rule against sibling-module imports is in the root `eslint.config.mjs`. Only the application lifecycle has a TypeScript mirror and a drift test.
Lifecycles added later (routing transmission, documents, signing, outbox, deletion) are SQL-only with pgTAP coverage; whether any needs a mirror has not been decided.

Part B: **nothing in this part is a finished contract.** What exists is the foundation it would formalise:

- `lending.inbound_messages` (unique on lender and message id, outcome and reason class, no body) and the private `apply_*` functions;
- the receiver `services/api/src/workers/lender-callbacks.ts` at `POST /v1/hooks/lenders/:lenderId`, with the message id and signature in `webhook-id`, `webhook-timestamp` and `webhook-signature` headers and a body of `{correlationRef, type, body}` (`LenderEventInput` in `packages/contracts/src/http/routing.ts`).
  Only a labelled **mock** scheme exists, refused in staging and production; real `api` connectors are refused until a scheme exists;
- the `LenderConnector` port with `submit` and `lookup`, an unconfigured connector, a mock and a timeout wrapper (`packages/adapters/src/lender-connector.ts`), and reconciliation rounds in the routing handlers.

Differences between today's wire format and the proposal: the lender id travels in the URL, the message id in a header, the time of the event is absent, and the correlation reference is a top-level member. Adopting the envelope means a new version of the endpoint, not a silent change.

## Alternatives considered

| Option                                                             | Why rejected                                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules in TypeScript services over generic tables (ADR-0003 layout) | Every client of the database (API, worker, admin script, a future service) would have to repeat the rules; the database could not refuse a bypass. |
| Both: rules in SQL and mirrored in TypeScript for every lifecycle  | Two sources of truth and a drift risk for each; justified only where a client needs the copy.                                                      |
| ORM-generated schema and logic                                     | Hides constraints, triggers and policies; awkward per-request role switching (ADR-0004).                                                           |
| A connector module per lender in code                              | Every lender becomes a project and a deployment; behaviour differences hide in code; tenant isolation depends on each connector.                   |
| Accept each lender's native format and translate at the edge       | Possible later as an adapter in front of the neutral envelope; making it the core contract would spread lender formats through the system.         |
| Unsigned or IP-allow-listed callbacks                              | A forged callback could move a lifecycle; addresses are weak identity.                                                                             |

## Consequences

**Positive**

- One place to read, test and audit each rule; clients cannot skip a rule.
- A new lender is configuration, a secret and a schema mapping, not a deployment.
- Retries, duplicates and lost messages are handled by design (idempotency by message id, reconciliation by lookup).

**Negative**

- Logic in SQL is harder to write and review than application code and needs migrations to change; the team must keep pgTAP strong.
- Postgres functions are less portable; moving off Postgres would be a rewrite of the rules.
- Lenders must adapt to the envelope; some will not sign messages the way we propose, which is why the scheme is per lender.
- Per-lender secrets add key management work (D-47, D-43).

**Risks**

- A rule slipped into a route (for speed) creates a second source of truth. Review rule: if it decides or changes state, it belongs in SQL.
- Messages can arrive out of order; apply functions must tolerate it. This is not yet tested against a real lender.
- The envelope may not fit a lender whose system cannot sign, which is a business question before a technical one.

## Compliance and security notes

- Keeping the decision with the lender and recording lender-reported status as such supports the "lenders decide, Udofin facilitates" principle (ADR-0007). It is a design constraint, not a compliance claim.
- Messages and logs carry identifiers and reason classes, never the borrower's phone number, PAN or Aadhaar number (`CLAUDE.md` rule 3).
- Primary-source verification gate applies (README).

## Verification

- Part A: pgTAP for every function (`supabase/tests/*`), the authorisation matrix (`006`), the lifecycle drift test, the integration tests under `services/api/test/integration/*`, and the lint rule.
- Part B today: `services/api/test/lender-callbacks.test.ts` (uniform refusal before authentication, a correctly signed event accepted, validation only after authentication) and the "signed callbacks" block of `services/api/test/integration/routing.integration.test.ts` against a real database (a valid event applied once and a replay ignored; bad signature, wrong secret, stale timestamp, tampered body and malformed JSON refused; unknown, manual and api-kind lenders indistinguishable). Planned when accepted: a contract test suite
  that a lender's sandbox can run against the envelope; out-of-order delivery tests; key-rotation tests.

## Revisit triggers

- The first real lender integration (D-43) shows the envelope is wrong.
- A lender cannot sign or insists on its own format.
- A rule must run somewhere other than Postgres (a heavy computation, a model).
- The team grows enough that logic in SQL becomes the bottleneck, or the database moves off Postgres.
