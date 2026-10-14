# Phase 01 repository baseline and implementation audit

Date: 14 October 2026. Mode: verification of the existing repository (no remediation). Head audited: `e1324a1` on branch `claude/peaceful-babbage-14p1ci` (draft PR 1). Author: the engineering agent, with two independent read-only reviewers (one on database/tenancy/authentication, one on API/workflow/configuration) whose findings I re-checked against the code where I could. The same agent wrote most of the code under review, so this is not an independent third-party audit.

The architecture decisions that follow from this audit are in `docs/architecture/phase-02-architecture-verification.md`.

Nothing in this report claims production readiness or regulatory compliance. Nothing has been deployed.

## 1. Executive summary

- **What exists:** a pnpm/Turborepo monorepo with a Fastify modular-monolith API (149 operations), an outbox worker and a signed-callback receiver, three client apps (Expo borrower app, ops portal, lender portal), 25 forward-only SQL migrations (83 tables, all with row-level security), 12 pgTAP files (825 assertions), and phases 02 to 07 of business logic (identity and consent, lender onboarding, products, lender routing, offers, KFS documents, acknowledgement and acceptance).
- **What was run and passed on this head:** format check, lint, typecheck, build, pgTAP (825), unit tests (387), API integration tests (130, run separately, section 11). CI on the head commit was green (5 of 5 jobs).
- **Not verified:** any hosted Supabase project, any deployed environment, any real provider, any device run of the mobile app, git history for secrets, and behaviour under load. The deployment document itself says nothing is deployed.
- **No Critical or High defects were found.** Confirmed defects are 1 Medium (token lifetime after sign-out), 1 Medium (unchecked uploaded PDFs in onboarding), 3 Low and several test gaps. The most important forward-looking risk is the payment-success guard (R-01), which is weak but has no code path yet.
- **Phases 03 and 04 conform** to their approved designs on the evidence in section 13. Phases 05 to 07 also exist; they were not part of the brief but are covered where relevant.

## 2. Repository and technology inventory

Package manager pnpm 10.28 (lockfile committed), Node 22.22 in this environment (engines `>=22.13 <25`), TypeScript ~6.0, ESM, Turborepo, Vitest 5, ESLint 10, Prettier. 479 tracked files.

| Path                                    | Purpose                                                                | Stack                                                        | Status (evidence)                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile` (57 ts/tsx, 8 test files) | Borrower app                                                           | Expo SDK 57, React Native, expo-router, own en/hi catalogues | Implemented screens for onboarding, loan request, lender choice, offers, KFS, acceptance, documents. Unit-tested (80 tests). Never run on a device.                  |
| `apps/ops-portal` (30, 0 tests)         | Udofin operations and administration                                   | Next.js, strict nonce CSP, cookie BFF                        | Onboarding, products, administration screens. No screens for document rules, templates or calendars (API only). Covered by 10 browser tests (fake Supabase and API). |
| `apps/lender-portal` (32, 0 tests)      | Lender operations                                                      | Next.js                                                      | Onboarding, products, panel, applications, KFS documents. Covered by the same browser tests only in part; new document screens have no browser test.                 |
| `services/api` (59, 18 test files)      | API, worker, callback receiver                                         | Fastify 5, zod 4, pg, route registry with generated OpenAPI  | Implemented and tested.                                                                                                                                              |
| `packages/domain`                       | Money (integer paise), state machines                                  | Pure TS                                                      | Implemented, 36 tests.                                                                                                                                               |
| `packages/contracts`                    | Wire contracts, problem details, events                                | zod                                                          | Implemented.                                                                                                                                                         |
| `packages/adapters`                     | Provider ports, mocks, environment guard, PDF renderer, document store | pdfkit, Noto fonts                                           | Ports and labelled mocks only; no real provider.                                                                                                                     |
| `packages/auth-client`, `portal-kit`    | Sessions, BFF handlers, shared portal UI                               |                                                              | Implemented.                                                                                                                                                         |
| `packages/design-tokens`                | Themes, tenant branding limits                                         |                                                              | Implemented.                                                                                                                                                         |
| `tests/e2e`                             | Browser tests                                                          | Playwright                                                   | 10 tests, opt-in (`E2E=1`).                                                                                                                                          |
| `supabase/migrations`, `supabase/tests` | Schema (source of truth), pgTAP                                        | Postgres 16 local, 17 in CI                                  | 25 files, 11,362 lines.                                                                                                                                              |
| `infra/`                                | `README.md`, `docker/api.Dockerfile`                                   |                                                              | Only a container build exists. No IaC, no deploy workflow.                                                                                                           |
| `docs/`                                 | Architecture, ADRs (31), regulatory, security, operations              | Markdown                                                     | Extensive; see section 14 for gaps.                                                                                                                                  |

Generated `dist` folders are git-ignored. TODO/FIXME markers appear in 2 source files only. No obsolete or duplicate application was found. Files that exist but do not "work" against a real counterparty: all provider adapters (SMS, device integrity, signing, lender connectors, object storage) are ports plus mocks.

## 3. Git and working tree

- Branch `claude/peaceful-babbage-14p1ci`, 96 commits since the initial commit of 10 October 2026, pushed and matching `origin`. `main` also exists locally and remotely.
- Working tree was clean before this report was written. This report is the only new file and is **not committed**.
- No stashes. No uncommitted work existed to preserve.
- The roadmap shows a different numbering for the original Phase 01 (a greenfield audit and architecture). The prompt in this file is the existing-repository variant; its Phase 03 and Phase 04 match the repository's Phase 03 (application foundation) and Phase 04 (lender onboarding).

## 4. Architecture and application boundaries

**Assessment: sound for the current scale; a modular monolith is appropriate and no service split is recommended.**

Evidence:

- Database access happens only through the API (`services/api/src/db`), as the `authenticated` role inside a transaction with the caller's claims (`user-context.ts`). The privileged system login is imported only from `src/system` and `src/workers` (checked by a boundary test and by search). The server refuses to start if the API login could bypass RLS.
- Business rules live in Postgres functions and `packages/domain`; clients do not decide eligibility, validity or approval. The mobile and portal code render what the API returns.
- Lender-specific behaviour is data (applicability rules, templates, calendars, connector configuration), not branches in code.

Observations:

- **A-01 (Info):** some business logic is implemented in SQL only (state machines, KFS validation), with `packages/domain` holding a parallel declaration for lifecycles. A drift test exists for the application lifecycle; confirm one exists for each new lifecycle (documents, signing) before relying on it.
- **A-02 (Info):** the portal apps share a UI kit (`portal-kit`) which also holds operation allow-lists. This is a reasonable single place for form-to-API mapping, but it makes `portal-kit` security-relevant; it is covered by 52 tests.

## 5. Database and data model

Checked live against a freshly migrated local database (Postgres 16) and by reading migrations. **Live verification of a hosted project was not performed.**

- 83 tables in domain schemas (`tenancy`, `identity`, `consent`, `audit`, `lending`, `servicing`, `payments`, `onboarding`, `documents`, `ops`). The `public` schema contains no tables and no functions.
- RLS is enabled on all 83. It is forced on all but six, which are deliberate shared reference tables: `consent.notices`, `lending.application_transitions`, `lending.product_categories`, `tenancy.permissions`, `tenancy.roles`, `tenancy.role_permissions`. Five tables (`identity.device_attestations`, `identity.integrity_nonces`, `identity.stepup_challenges`, `ops.idempotency_keys`, `ops.outbox_events`) have forced RLS and no policy, which means only the owner and the system role can reach them (intended).
- `anon` and `PUBLIC` hold no table grants and no execute rights on domain functions. All 189 `security definer` functions pin an empty `search_path` (live catalogue query returned zero exceptions).
- Money is `bigint` paise throughout; a search for `float`, `numeric` and `real` columns found none (the only `double precision` is a local delay variable in the outbox function).
- Tenant keys: `lender_org_id` with composite foreign keys on tenant-owned tables; append-only triggers on ledgers, snapshots, events and acknowledgements.
- `authenticated` holds INSERT (never DELETE/TRUNCATE) on six tables: `consent.records`, `lending.loan_products`, `lending.loan_product_versions`, `lending.loan_requests`, `lending.offers`, `lending.panel_views`. Each is guarded by an insert policy with a tenant or owner check and, for products and offers, a permission check.

Findings in section 15: F-07 (documents schema not in the grant snapshot test), F-08, R-01, R-05, R-06.

## 6. Authentication and authorization

- Token verification (`auth/token-verifier.ts`): asymmetric algorithms only, JWKS, issuer, audience, expiry, subject, role and `aal` enforced. Permissions are never read from the token; the actor and memberships are resolved in the database for every request (`private.current_actor()`), so role removal and staff offboarding take effect immediately.
- Staff require AAL2 (TOTP) in both the API and the database. Borrowers use phone OTP via a signed Send-SMS hook; step-up codes are HMAC-hashed, attempt-limited, single-use and context-bound.
- Portal sessions use a backend-for-frontend with `__Host-` HttpOnly SameSite=Strict cookies, an Origin and content-type guard, and a `wrong_portal` check. Mobile stores the session in the Keystore/Keychain with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; `allowBackup: false` is enforced by a config check script.
- **Confirmed defect F-01 (Medium):** the API does not check that the session behind an access token still exists. After sign-out or revocation, a copied access token works until it expires (900 s locally; hosted value unverified). Membership changes are still immediate.
- **F-05 (Low):** the portal sign-in rate limiter is in-memory and per process, and requests without a usable forwarded address share one bucket.
- **F-06 (Low):** the replay cache for the Send-SMS hook is per process (300 s window).
- Not verified: hosted Supabase settings (lifetime, sign-up, MFA enforcement, hooks), and Next.js server-action/route-handler CSRF behaviour of the portal apps beyond the BFF guard.

## 7. Multi-tenancy and RLS

- Tenant identity cannot be client-supplied: it is derived from database membership. Every tenant query is also scoped by policy.
- Cross-tenant negative tests exist for loan accounts, schedules, payments, consent, applications, products, routing, onboarding, panel and documents (pgTAP 002, 008 to 012; integration tests for routes).
- **F-07 (Low, test gap; introduced by Phase 07):** the `documents` schema is not in the table-grant and forced-RLS snapshot of `006_authorization_matrix.test.sql` or the schema lists of `001_structure.test.sql`. The migrations themselves enable and force RLS; a later grant regression there would not fail CI.
- **F-08 (Low, test gap):** the search-path/definer structure test covers only the `private` schema (static count and the live query above show no exception today).
- **F-09 (Low, to verify):** the reviewer found no negative test for `tenancy.lender_settlement_accounts` beyond the matrix row; two lines mention it in `002_tenant_isolation`. Confirm a cross-lender and borrower negative case exists.
- Many `authenticated`-granted functions accept caller-chosen values (for example step-up hashes). They are safe only because clients reach the database solely through the API and the domain schemas are not exposed by PostgREST (`config.toml` exposes `public` and `graphql_public`, both empty). **R-04:** this is a deployment control that has no automated test; add one (a request to the REST endpoint for a domain function must fail) before staging.

## 8. API and business logic

- 149 operations. A route registry validates params, query and body with zod, validates responses against the declared schema, applies auth and rate limits uniformly, and generates `docs/api/openapi.json`, which a test checks for staleness. The OpenAPI route is not registered in production.
- Unauthenticated operations: `/health/live`, `/health/ready` (dependency names only) and the signed `/v1/hooks/send-sms`.
- Idempotency: 89 of 90 POST routes require it; the exception is the signed SMS hook, which de-duplicates by message id. Idempotency is stored in Postgres inside the business transaction. The outbox is at-least-once with leases and dead-lettering.
- Errors are RFC 9457 problem+json with stable codes; 5xx details never reach the client.
- Logging redacts headers and keys at any depth; request logs omit the query string.
- **F-02 (Medium):** `services/api/src/modules/onboarding/routes.ts:233-240` checks only magic bytes for uploads. The KFS upload route additionally refuses PDFs naming JavaScript, OpenAction, Launch, EmbeddedFile or AA (`documents/routes.ts:63`). Onboarding evidence is opened by lender and platform staff, so the same risk applies. Verification (local only): upload a harmless PDF containing the token `/OpenAction` to an onboarding evidence route (accepted) and to `kfs-upload` (refused with `document_type_mismatch`). The KFS check is also bypassable by hex-escaped names and by object streams; it is a coarse filter, not a scanner.
- **F-03 (Low):** the lender callback receiver answers 503 `callback_scheme_not_configured` for an active API-connector lender before any signature check, and 404 for other lenders, which lets an unauthenticated caller tell them apart by guessing lender ids (`workers/lender-callbacks.ts:84-99`).
- **F-04 (Low):** the error handler returns the framework's own message on 4xx responses (`app.ts:150-157`). Fixed messages per status are safer.
- **R-02 (Medium for availability):** `TRUST_PROXY_HOPS` defaults to 0 and deployed validation does not require it. Behind a load balancer all clients would share one rate-limit bucket. Limits are per IP only.
- **R-03 (Low):** `ops.idempotency_keys.response_body` keeps full responses for 24 hours; confirm grants stay system-only (forced RLS with no policy, as above).
- **R-07 (Info):** several routes read bigint money with `Number(...)`; safe today because amounts are capped well below 2^53.

## 9. Financial and workflow integrity

Implemented parts only: loan accounts and schedule snapshots as lender-reported read models, payment intents and provider events (tables and guards, no ingest code), offers and acceptance.

- State changes follow declared lifecycles enforced by triggers; history tables are append-only; intents are immutable in amount and parties; only the system role can finalise an intent; borrowers cannot insert intents.
- **R-01 (Medium once payments exist):** `20261010000600_hardening.sql:603-609` lets an intent become `succeeded` when any signature-verified provider event exists for it. It does not require a success status or that `amount_minor` equals the intent's amount, and `provider_events.amount_minor` has no check constraint. CLAUDE.md rule 4 requires verified callbacks and reconciliation. There is no ingest code, so this cannot be triggered today; fix before the first payment integration.
- **R-05 (Info):** `servicing.loan_accounts` is updatable and keeps no status history, although the header promises an immutable copy of what the LMS reported.
- Reconciliation, disbursement and repayment engines do not exist and are correctly absent (Udofin does not hold funds or own the loan record).

## 10. Documents and sensitive data

- No public buckets or signed URLs: files are returned only after a database authorisation call and every retrieval is recorded. Storage keys are opaque UUIDs with traversal checks; SHA-256 is recorded and re-checked on read. KYC artefacts are not stored; phone numbers are never written to Udofin tables (canary-scan integration test).
- The only store implementation is a local filesystem store, refused outside local and test. The production store (S3 with KMS) is a port with no implementation, so staging and production return 503 on document routes. The comment at `server.ts:60-62` says the adapter "exists" and overstates this (documentation gap G-01).
- Retention is undefined: documents carry `retention_class = 'pending_d25'` (decision D-25 open). Deletion of auth identities is pending.
- No malware scanning or per-lender storage quota (R-06). Request logs record the remote IP address; confirm that is intended (R-08).
- Secrets: a scan of the tracked tree (key prefixes, private key blocks, JWT shapes) found only allow-listed synthetic test strings; `.env.example` files hold placeholders. **Git history was not scanned by me**; CI runs gitleaks on full history and passed. The gitleaks allowlist is not path-scoped (R-09, Low).

## 11. Tests, build and quality

Run on `e1324a1`, local Postgres 16, no network services except the dependency audit.

| Check                                                                                                         | Result                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                                                           | Passed                                                                                                                                                                                                                                                                                   |
| `pnpm lint`                                                                                                   | Passed (17 tasks)                                                                                                                                                                                                                                                                        |
| `pnpm typecheck`                                                                                              | Passed (17 tasks)                                                                                                                                                                                                                                                                        |
| `pnpm build`                                                                                                  | Passed (9 tasks)                                                                                                                                                                                                                                                                         |
| pgTAP (`scripts/db-test-local.sh`: migrations then 12 files)                                                  | 825 assertions, passed                                                                                                                                                                                                                                                                   |
| `pnpm test` (unit)                                                                                            | domain 36, design-tokens 8, contracts 12, auth-client 80, portal-kit 52, mobile 80, adapters 52, API 67: all passed. 130 API integration tests and 10 browser tests were **skipped** in this run (see next rows)                                                                         |
| API integration tests (`pnpm --filter @udofin/api test` with the integration URLs, freshly migrated database) | 197 of 197 passed (130 integration), run earlier in this session at `e1324a1` and at its parent; not repeated for this report                                                                                                                                                            |
| Browser tests (`E2E=1`)                                                                                       | 10 of 10 passed, earlier in this session; not repeated for this report                                                                                                                                                                                                                   |
| CI on `e1324a1`                                                                                               | 5 of 5 jobs passed                                                                                                                                                                                                                                                                       |
| `pnpm audit --prod`                                                                                           | 4 findings: 2 high (the two accepted in `docs/security/risk-acceptances.md`, RA-001/RA-002, review date 2026-11-10) and 2 moderate in mobile build tooling (`uuid` via `@expo/config-plugins`, `decode-uri-component` via `expo-router`). CI blocks high/critical not on the ignore list |

- **F-10 (Info):** running the integration tests through the root `pnpm test` skips them because Turborepo's strict environment mode does not pass the `INTEGRATION_*` variables. A developer can believe the suite ran. Document it or add the variables to `turbo.json` `env`.
- PDF text assertions return silently if `pdftotext` is absent, so they can pass without checking (documented in `docs/testing/strategy.md`).
- Not covered by any test: real providers, device behaviour, browser flows for the Phase 07 lender screens, load and failure injection beyond the unit level.

## 12. Configuration and deployment

- Configuration validation (`config.ts`) rejects, when deployed: mock providers, the local document store, missing database URLs, non-TLS Postgres, `trace` logging in production, and wildcard or non-https CORS origins. Messages name variables, not values.
- CI actions are pinned to commit SHAs with read-only permissions; Dependabot covers npm, Actions and Docker; CODEOWNERS covers migrations, API and security docs. The Dockerfile is multi-stage, runs as `node`, and excludes `.env` files. The base image is pinned by tag, not digest (RA-003).
- **G-02:** `docs/operations/deployment.md` correctly states nothing is deployed. Backups, point-in-time recovery, monitoring, IaC, image scanning, SAST, SBOM and migration linting are listed as planned and are not evidenced. **R-02** and **R-04** above are deployment prerequisites.
- Hosted Supabase configuration, AWS resources, India data residency of any real environment and migration application order on a managed instance were **not verified**.
- Roles: `udofin_api` and `udofin_system` grants can fail with only a warning on managed Supabase (`20261013000720_api_login_roles.sql:27-34`); the API boot guard checks its own login, nothing checks the system login exists with the right grants (R-10).

## 13. Phase 03 and Phase 04 conformance

Phase 03 (foundation): authentication and authorization foundations, API conventions with generated and tested documentation, idempotency in Postgres, a transactional outbox with a worker, application shells and routing, problem+json errors and the test layers are all present with evidence above. **Conforms.** Gaps are the ones in section 15 (token lifetime, in-memory limiters).

Phase 04 (lender onboarding): lender profile and gated onboarding (`onboarding.*`, ADR 0028), institution-type flexibility through a category table with per-category rules, regulatory verification records and evidence documents, accounting framework and Ind AS status with an optional waiver (D-33), engagement scope, product configuration with maker-checker, lender memberships and roles, audit trail, and activation gates are implemented and covered by `008` and `009` and the onboarding integration tests. **Conforms** on repository evidence. Pending by decision rather than defect: banks and cooperative banks cannot go live (`activation_allowed` false until their rules are read), the real registry/regulator verification sources, and retention.

Phases 05 to 07 are outside the brief and are recorded in their own specifications and security reviews.

## 14. Missing evidence and verification limitations

- No hosted or deployed environment was inspected. No real provider, device, or load test.
- Git history was not scanned by me for secrets (CI does).
- The reviewers read, but I did not re-read, every one of ~190 definer function bodies; a sample was checked and the live catalogue checks above were run by me.
- The mobile app beyond session storage (deep links, permissions) and lender-portal parity with the ops portal were read only lightly.
- Two reviewers could not run code; their findings are from reading. I re-verified F-02, F-03, R-01, F-07 and the unforced-RLS list myself.
- Documentation gaps: G-01 (store comment), G-03 residual access-token lifetime after sign-out is not stated, G-04 the in-memory limiter caveat is only in a code comment, G-05 the matrix note on unforced tables does not mention `application_transitions` and `product_categories`.
- The earlier Phase 01 audit documents (`docs/security/review-2026-10-10.md` and the roadmap entry) exist; this report does not replace them.

## 15. Prioritised findings

Severity is my judgement on current evidence. "Blocks" means blocks the next phase of development.

### Confirmed defects

| ID   | Sev    | Finding                                                            | Evidence                                                                                                        | Blocks                                                                                                                             |
| ---- | ------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | Medium | Access tokens outlive sign-out/revocation until expiry             | `auth/token-verifier.ts:44-67` never checks `session_id`; `auth-client/src/gotrue.ts:231` logs out locally only | No; must be decided before staging (check `session_id` for staff and step-up routes, or accept and document with a short lifetime) |
| F-02 | Medium | Onboarding uploads skip the active-content PDF check               | `onboarding/routes.ts:233-240` vs `documents/routes.ts:63,459`                                                  | No; fix with one shared upload-validation helper                                                                                   |
| F-03 | Low    | Callback receiver distinguishes lenders before signature check     | `workers/lender-callbacks.ts:84-99`                                                                             | No                                                                                                                                 |
| F-04 | Low    | Framework error text returned on 4xx                               | `app.ts:150-157`                                                                                                | No                                                                                                                                 |
| F-05 | Low    | In-memory sign-in/MFA limiter; shared "unknown" bucket             | `auth-client/src/web/rate-limiter.ts`, `portal-env.ts:67-75`                                                    | Blocks multi-instance deployment                                                                                                   |
| F-06 | Low    | Hook replay cache per process                                      | `borrower/routes.ts:122`                                                                                        | Blocks multi-instance deployment                                                                                                   |
| F-07 | Low    | `documents` schema absent from the grant/forced-RLS snapshot tests | `006_authorization_matrix.test.sql`, `001_structure.test.sql`                                                   | No; my omission in Phase 07, fix promptly                                                                                          |
| F-08 | Low    | Definer/search-path test covers `private` only                     | `001_structure.test.sql:46-61`                                                                                  | No                                                                                                                                 |
| F-10 | Info   | Root `pnpm test` silently skips integration tests                  | Turborepo env mode; 130 skipped in section 11                                                                   | No                                                                                                                                 |

### Potential risks needing verification

| ID                 | Sev                              | Risk                                                                                                                                            | Action                                                                                              |
| ------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| R-01               | Medium (when payments are built) | Payment success needs only any verified event; no amount or status match                                                                        | Add status allow-list, amount equality and pgTAP negatives before any payment ingest                |
| R-02               | Medium (availability)            | `TRUST_PROXY_HOPS` default 0, not required when deployed; per-IP limits only                                                                    | Require explicit value when deployed; add per-principal limits                                      |
| R-04               | Medium (deployment)              | Domain functions are safe only if PostgREST never exposes them                                                                                  | Add an automated check against the REST endpoint; confirm `pg_graphql` is off on the hosted project |
| F-09 / R-10        | Low                              | Settlement-account negative test; system-login grants on managed Supabase                                                                       | Verify                                                                                              |
| R-03, R-05 to R-09 | Low/Info                         | Idempotency body retention; loan-account history; no malware scan or quota; IP in logs; unscoped gitleaks allowlist; unwired audit-ignore scope | Schedule                                                                                            |

### Documentation gaps: G-01 to G-05 (section 14).

### Planned but unimplemented (correctly labelled): production object store, real SMS/integrity/signing/lender connectors, production key manager, payment ingest, retention (D-25), IaC and deployment pipeline, backup/restore evidence, image scanning/SAST/SBOM, bank and UCB rules, KFS rules beyond the draft NBFC rule.

### Architectural opportunities: shared upload validation; a short, enforced token lifetime with optional session check; a shared rate-limit store before more than one portal instance; CI check that the two ignored advisories never enter the API dependency tree.

## 16. Recommended remediation backlog (not started)

1. **Before staging:** R-02, R-04, F-01 decision, F-05, F-06, R-10, hosted-settings checklist, production object store with encryption, retention decision D-25.
2. **Before any payment work:** R-01 with tests.
3. **Next hardening pass (small):** F-02 and F-04 and F-03 together; F-07, F-08, F-09 test additions; F-10 documentation; CI check on the audit-ignore scope.
4. **Housekeeping:** G-01 to G-05; confirm IP logging; path-scope the gitleaks allowlist; loan-account status history.

No remediation in this backlog has been implemented.
