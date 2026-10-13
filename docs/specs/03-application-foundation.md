# Phase 03 specification and implementation record: application foundation

**Status:** implemented on branch `claude/peaceful-babbage-14p1ci` (PR 1) on 13 October 2026, on the owner's written instruction to implement Phase 03 ("deep research … and go ahead", then the Phase 03 brief). The four research agents planned for this phase were stopped before writing anything, so the technical choices below rest on the engineer's knowledge and on the tests, **not** on fresh external research. Statements about Supabase Auth endpoints and Expo behaviour are therefore labelled _unverified against current vendor documentation_ until checked against a real project (see section 8).
**Depends on:** Phase 01 baseline, Phase 02 (approved 13 Oct 2026).
**Out of scope here (still roadmap Phase 03 items, not started):** infrastructure as code, cloud deployment workflows, observability pipeline, merged-AndroidManifest release check. They need the hosting decision and cost approval.

## 1. Objective in plain English

Make every front end sign in safely and talk to a documented, retry-safe API, and make background work reliable:

1. Staff sign in to the two portals with email, password and an authenticator-app code. Borrowers sign in on the phone with an SMS code.
2. The API describes itself (OpenAPI), validates every request and response, and refuses a duplicate submission instead of doing it twice.
3. Anything that must happen "after" a database change (here: applying an approved administrative change) is recorded **in the same transaction** and carried out by a worker that survives crashes.

No lending feature, KYC, credit decision or repayment screen is built.

## 2. Decisions made (and why)

| #   | Decision                                                                                                                                                            | Why                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Portals use a backend-for-frontend (BFF) with HttpOnly cookies** (ADR 0026). The browser talks only to its own origin; tokens never reach page scripts.           | XSS cannot steal a token it cannot read; the strict CSP (`connect-src 'self'`) already blocks calls to other origins.                                                                                 |
| 2   | **No Supabase SDK**: a small typed client (`@udofin/auth-client`) calls the Supabase Auth REST API with the publishable key only.                                   | Fewer dependencies in a regulated product; the surface we use is six endpoints. _Unverified against current GoTrue docs._                                                                             |
| 3   | **Idempotency in Postgres, inside the business transaction** (ADR 0027).                                                                                            | A duplicate waits on a unique index and then replays the stored result; a rolled-back attempt leaves no record. No in-memory store is authoritative.                                                  |
| 4   | **A Postgres outbox and our own worker, not pg-boss** (ADR 0011 amended).                                                                                           | The outbox row commits with the change by construction, claims use `FOR UPDATE SKIP LOCKED` with leases, and there is nothing new to operate. pg-boss can be adopted later behind the same interface. |
| 5   | **OpenAPI is generated from the same declarations that serve the routes** (own small registry on zod 4's JSON Schema output), with a contract test.                 | The documentation cannot describe an endpoint the code does not serve; avoids a dependency whose zod 4 support was not verified.                                                                      |
| 6   | **Approving a change request now enqueues its application** (outbox) instead of applying inline.                                                                    | Phase 02 left a crash window between decision and application. Now the decision and the job commit together; the worker retries and dead-letters.                                                     |
| 7   | **Borrower sign-in is phone OTP now** (client side), but real SMS delivery needs the provider and DLT registration (Phase 05). Production-readiness is not claimed. | The app flow, storage and tests exist; only the sender is missing.                                                                                                                                    |

## 3. What was built

| Area                    | Where                                                           | Notes                                                                                                                              |
| ----------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Migration `…000730`     | `supabase/migrations/20261013000730_idempotency_and_outbox.sql` | Schema `ops`: `idempotency_keys`, `outbox_events`, claim/complete/fail/requeue/purge functions; `decide_change_request` enqueues.  |
| Route registry, OpenAPI | `services/api/src/http/*`, `docs/api/openapi.json`              | Every route declares request and response schemas; responses are validated; a test fails on undeclared routes or a stale document. |
| Idempotency             | `services/api/src/idempotency/*`, `private.idempotency_*`       | Key scoped to principal and route; request fingerprint; replay; conflict 422; expiry 24 h.                                         |
| Outbox worker           | `services/api/src/workers/*`                                    | Leases, bounded retries with backoff, dead state, only an error _code_ is stored.                                                  |
| Shared auth code        | `packages/auth-client`                                          | Auth client, session manager (single-flight refresh), web BFF handlers, typed API client, portal configuration.                    |
| UI kit                  | `packages/portal-kit`                                           | Accessible sign-in with second factor, sign-out, shell, state panels (10 tests).                                                   |
| Portals                 | `apps/ops-portal`, `apps/lender-portal`                         | Sign-in, role-aware shell, session refresh in `proxy.ts`; ops lists and decides change requests.                                   |
| Mobile                  | `apps/mobile`                                                   | Phone OTP, keystore session, guarded routes, offline and error states, screenshot blocking on the code screen.                     |
| Browser tests           | `tests/e2e`                                                     | 10 Chromium tests against both built portals with fake Supabase Auth and API.                                                      |

## 4. Acceptance criteria and where each is tested

| #   | Criterion                                                                                                                      | Test                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | API rejects wrong-key, expired, wrong-audience tokens; key rotation works                                                      | `services/api/test/token-verifier.test.ts` (Phase 02)                                                                          |
| 2   | OpenAPI generated; a test fails if a route lacks schemas or is undocumented                                                    | `test/openapi.test.ts` (8 tests incl. "running app registers exactly the declared routes" and "committed document is current") |
| 3   | Idempotent POST without key → 400; same key → original result, nothing new; changed body → 422; concurrent; failure then retry | `test/integration/api.integration.test.ts` › idempotency (9 tests), `supabase/tests/007_idempotency_outbox.test.sql`           |
| 4   | Domain change and outbox row commit or roll back together                                                                      | integration "a decision that rolls back leaves no outbox event"; pgTAP 007                                                     |
| 5   | Worker: retries, dead-letter, duplicate delivery, concurrent workers, abandoned-lease recovery, invalid payloads, safe logging | integration › worker reliability (3 tests) and two-person flow (4 tests); `test/outbox-worker.test.ts` (7)                     |
| 6   | Cross-tenant and role restrictions through the API                                                                             | integration › authentication and authorisation (7 tests); pgTAP 002/005/006                                                    |
| 7   | Staff MFA enforced; no account enumeration; rate limits; CSRF; cookie flags; token not in page source                          | `packages/auth-client/test/*` (59), `tests/e2e` (10)                                                                           |
| 8   | Mobile: keystore storage, session refresh, config refuses privileged keys, OTP guard rails                                     | `apps/mobile/test/*` (16), `expo export --platform android` bundle builds                                                      |
| 9   | Mocked vs production clearly distinguished                                                                                     | section 7 below                                                                                                                |

## 5. Failure and security considerations

| Risk                                 | Handling                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token theft from the browser         | HttpOnly, SameSite=Strict, `__Host-` cookies on https; nothing in storage or page source (tested).                                                         |
| CSRF on auth endpoints               | Same-origin check (Origin / Sec-Fetch-Site), JSON-only, SameSite=Strict; Next server actions add their own origin check.                                   |
| Brute force / lock-out abuse         | Limits per address and per address+account, plus a loose account ceiling; Supabase limits and the second factor remain the authoritative protection.       |
| Account enumeration                  | One generic message and status for unknown user and wrong password.                                                                                        |
| Privileged key in a bundle           | Portals and the app refuse `sb_secret_…` and `service_role` keys at start-up (tested).                                                                     |
| Duplicate financial or admin effects | Idempotency store + domain guards + deduplicated outbox events + idempotent handler (re-delivery is a no-op).                                              |
| Poison job                           | Bounded attempts, then the `dead` state; operators replay with `ops.requeue_dead_event`.                                                                   |
| Personal data in jobs or logs        | Payload key deny-list and size cap in the database; handlers receive ids only; only error codes are stored; worker logs error class names, never messages. |
| Stale permissions                    | Permissions come from the database on every request; a suspended member loses access on the next request (tested).                                         |

## 6. Known limitations (honest list)

1. In-memory rate limiters in the portals are per process. Behind several instances, move them to a shared store; Supabase's own limits still apply.
2. The worker has no heartbeat/lease extension; handlers must finish within the 60 s lease.
3. Idempotency responses are stored verbatim: only non-personal bodies may be stored (rule recorded in `docs/api/idempotency-and-outbox.md`).
4. Real SMS delivery, DLT registration and production Supabase projects do not exist yet.
5. The merged-AndroidManifest release check, IaC, deployment workflows and observability are not built.
6. **Phone-OTP abuse controls are not in place.** The 30-second resend guard and wrong-code limit live in the app; anyone can call the auth server's OTP endpoint directly with the publishable key (SMS pumping, exhausting the project's SMS limit). Before Phase 05 turns SMS on: enable Supabase captcha/attestation and per-IP limits, and set a spending cap with the SMS provider.
7. A signed-out or copied **access token** stays valid until it expires (15 minutes); only refresh tokens are revoked at sign-out.
8. iOS keeps its app-switcher snapshot of the code screen (Android hides it); an inactive-state cover is not built.
9. Browser tests use fakes for Supabase Auth and the API: they prove the portals, not Supabase's behaviour. A staging project with synthetic data is needed for a true end-to-end run.
10. The mobile UI has been type-checked, linted and bundled, and its logic unit-tested; it has **not** been run on a device or emulator in this environment.

## 7. Mocked, sandboxed and production

| Item                            | Status                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Fake Supabase Auth and fake API | Test doubles in `tests/e2e/src/fakes.ts` only. Not importable by apps; never deployed.                           |
| `test.*` event handlers         | Defined inside the integration test only.                                                                        |
| Supabase test OTP numbers       | Not enabled anywhere; `supabase/config.toml` keeps the setting commented out and must never be pushed hosted.    |
| Everything else in this phase   | Real code paths; **none is deployed**, so nothing here is "production-ready" until the checks in section 8 pass. |

## 8. Before relying on this (verification list)

1. Create a staging Supabase project (Mumbai, synthetic data), apply migrations, set passwords for `udofin_api`/`udofin_system` (runbook), and run the API integration tests and a manual sign-in against it.
2. Confirm the GoTrue endpoints, factor flow and `aal` claim against that project (we use `/token`, `/user`, `/logout`, `/factors`, `/factors/{id}/challenge|verify`, `/otp`, `/verify`).
3. Run the mobile app on an Android device with a development build; confirm `FLAG_SECURE` on the code screen and keystore persistence.
4. Choose and approve hosting (static outbound address) before any deployment work.
