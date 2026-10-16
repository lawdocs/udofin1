# Security checklist: gates for every pull request and every release

- **Date:** 2026-10-10. **Owner:** security lead (engineering owner not yet appointed). **Approver:** product owner.
- **Related:** [`threat-model.md`](threat-model.md) (threats and gaps G-01 to G-25),
  [`mobile-permissions.md`](mobile-permissions.md), [`risk-acceptances.md`](risk-acceptances.md),
  [`../testing/strategy.md`](../testing/strategy.md), `.github/pull_request_template.md`,
  `.github/workflows/ci.yml`.

> **Research limitation.** Regulatory items below (CERT-In, RBI, DPDP) come from research that could
> not open primary sources (rbi.org.in and others were unreachable; the search budget ran out).
> They rest on secondary sources and carry the research status labels **confirmed / likely /
> interpretation / unverified**. Each must be verified against the primary text before launch; that
> verification is itself a release gate (B-13).

## How to use this checklist

1. The author copies section A into the pull request (the PR template already covers part of it)
   and marks each item `[x]`, or writes `n/a: <reason>`. An unexplained blank is a failed gate.
2. The reviewer checks the evidence, not the tick. "Evidence" means a test name, a command output
   or a file reference.
3. Anything that cannot be met is either fixed or recorded in
   [`risk-acceptances.md`](risk-acceptances.md) with an owner and a review date. Nothing that runs
   on servers or borrowers' devices may be accepted silently.

Tags: **[CI]** enforced automatically by `.github/workflows/ci.yml` today. **[Review]** checked by
the reviewer. **[Planned NN]** not automated yet; the number is the roadmap phase that automates it
(until then it is a **[Review]** item).

---

## A. Every pull request

### A-1 Build and test

- [ ] **[CI]** `pnpm format:check`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` pass (job `quality`).
- [ ] **[CI]** Migrations apply and all pgTAP tests pass on the Supabase stack, Postgres 17 (job `database`: `supabase db start && supabase test db`).
- [ ] **[CI]** Production mobile config resolves (`pnpm --filter @udofin/mobile config:check` with `APP_ENV=production`). This does not inspect the merged manifest; see A-14.
- [ ] **[CI]** API container image builds (job `api-image`).
- [ ] **[Review]** The PR description pastes the commands run locally and their results, including `PGHOST=… bash scripts/db-test-local.sh` for any database change. Only tests that actually ran are reported.
- [ ] **[Review]** New or changed behaviour has tests, including at least one negative test (what must be refused). A package must not rely on `--passWithNoTests` (G-22).

### A-2 Authentication and authorisation

- [ ] **[Review]** Every new endpoint requires a verified token, except endpoints explicitly listed as public (today only `/health/live` and `/health/ready`).
- [ ] **[Review]** Authorisation is decided server-side from permissions (for example `application.decide`), not from role names, UI state or client-supplied fields.
- [ ] **[Review]** Objects are loaded through a query that runs under RLS for the caller; an object the caller cannot see returns 404, not 403 (avoids confirming that it exists).
- [ ] **[Review] [Planned 02]** The API sets `request.jwt.claims` only from the verified token and always uses `SET LOCAL ROLE authenticated`; it never takes a database role from a token claim.
- [ ] **[Review] [Planned 02]** `service_role` (or any RLS-bypassing credential) appears only in worker code paths. A lint rule will enforce this.
- [ ] **[Review] [Planned 02/03]** Staff endpoints refuse sessions without a completed second factor.
- [ ] **[Review]** New permissions are added by migration, with `platform_grantable` and `platform_only` set deliberately and explained in the PR.
- [ ] **[Review]** Maker-checker applies to any configuration that changes what borrowers see or pay (products, consent wording, settlement accounts, lender status): the approver is a different person and holds the approving permission, and the approver cannot change the content while approving (G-04).

### A-3 Tenant isolation

- [ ] **[Review]** Every new tenant-owned table has `lender_org_id not null`, references parents through composite keys `(id, lender_org_id)`, and ties `borrower_id` to the parent's borrower where one exists (G-08).
- [ ] **[CI]** RLS is enabled on every domain table and forced on tables with borrower or tenant data; `anon` and `public` have no table privileges; `authenticated` has no DELETE (T001 assertions).
- [ ] **[Review]** pgTAP tests for the new table or policy cover: lender A vs lender B, borrower 1 vs borrower 2, the operations agent (read-only), staff with no role, and a suspended membership. Both "can" and "cannot" cases are asserted.
- [ ] **[Review] [Planned 02]** The authorisation matrix (every role × permission × table, select/insert/update/delete) is extended for the new table.
- [ ] **[Review] [Planned 03]** API tests: a lender A token requesting a lender B id gets 404; a borrower token requesting another borrower's id gets 404.
- [ ] **[Review]** Jobs and webhook handlers that run as the system take the tenant from Udofin's own record, never from the incoming payload.

### A-4 Input validation

- [ ] **[Review]** Every body, query and path parameter has a zod schema; unknown keys are rejected; strings have length limits; enums are closed.
- [ ] **[Review]** Money uses integer paise (`packages/domain` `Money`; `MoneyMinor` on the wire from `packages/contracts`). No floating-point money anywhere.
- [ ] **[Review]** Timestamps on the wire are RFC 3339 with an offset (`Timestamp` in `packages/contracts`).
- [ ] **[Review]** No string concatenation into SQL; parameters only (Kysely). SQL injection would let an attacker set `request.jwt.claims` and impersonate any user.
- [ ] **[Review]** Uploads (from Phase 07) check size and type on the server; filenames are never used as storage keys.

### A-5 Database migrations

- [ ] **[Review]** Migration reviewed against [`../data/migrations.md`](../data/migrations.md): forward-only, locking impact, data loss, backward compatibility.
- [ ] **[Review]** New tables: RLS enabled (and forced where they hold borrower or tenant data), explicit grants, no DELETE grant to `authenticated`, column-level UPDATE grants only for fields users may change.
- [ ] **[Review]** `security definer` functions set `search_path = ''`, revoke EXECUTE from `public` and grant it explicitly (T001 checks the first two).
- [ ] **[Review]** Append-only tables block UPDATE, DELETE **and TRUNCATE** (G-01).
- [ ] **[Review]** Timestamps and actors that serve as evidence (`captured_at`, `issued_at`, `created_by`, `approved_by`) are set by the database from the session, not accepted from the caller (G-12, G-14).
- [ ] **[Review]** No PAN, Aadhaar number, date of birth, document image or biometric data in Udofin's core schemas; any new personal-data column has an entry in [`../data/ownership.md`](../data/ownership.md).
- [ ] **[Review]** Reference-data changes (product categories, permissions, transitions) are in a reviewed migration. If `lending.application_transitions` changes, `packages/domain/src/lifecycles/application.ts` changes too (the lifecycle-sync test fails otherwise).

### A-6 Secrets and configuration

- [ ] **[CI]** gitleaks finds no secret in the repository history (job `secrets`).
- [ ] **[Review]** No secret, key or credential in code, tests, fixtures, screenshots or docs. No secret in any `EXPO_PUBLIC_*` or `NEXT_PUBLIC_*` variable: those are bundled into apps and pages and are public.
- [ ] **[Review]** New environment variables are added to the zod schema in `services/api/src/config.ts` (fail fast, never echo values) and to the relevant `.env.example` with a placeholder.
- [ ] **[Review]** Defaults are safe for a deployed environment; a missing value in staging or production stops the service instead of falling back to a local setting (G-19).

### A-7 Logging and personal data

- [ ] **[Review]** Logs carry ids (application id, request id), not objects or request bodies.
- [ ] **[Review]** Any new personal-data field name is added to `REDACTED_KEYS` in `services/api/src/logger.ts`, with a test in `services/api/test/logger.test.ts`. Remember the redaction gaps listed in G-03 (depth, snake_case, error `detail`).
- [ ] **[Review]** No personal data in URLs, query strings, error messages (`detail`), event `subject` fields, push payloads or analytics events.
- [ ] **[Review]** Integration events carry the `dataclassification` label (`packages/contracts`), and `restricted` data never goes into logs.
- [ ] **[Review] [Planned 03]** Canary scan: synthetic PAN, Aadhaar-format number and phone sent through new routes leave no trace in stored logs or traces.

### A-8 Rate limits and abuse

- [ ] **[Review]** New public or unauthenticated endpoints have an explicit rate limit; OTP, login and other cost-bearing endpoints have per-identifier budgets, not only per-IP.
- [ ] **[Review] [Planned 03]** Limits use a store shared across instances (G-21).

### A-9 Idempotency and money movement

- [ ] **[Review] [Planned 03]** Every financial POST requires `Idempotency-Key`; the same key returns the original result; the same key with a different body returns 422 (G-17).
- [ ] **[Review]** Status changes go through the declared state machines; terminal states stay final; only the system records money outcomes (`succeeded`, `failed`, `disbursed`).
- [ ] **[Review]** Repayments settle only to the lender's own account, taken from lender configuration, never from client input (G-15). No split settlement to Udofin; no Udofin pool or pass-through account (likely; providers research PAY-01).
- [ ] **[Review]** Outbound calls that create or move something send an idempotency key, and a timeout is followed by a status enquiry, never a blind retry.

### A-10 Webhooks and integrations

- [ ] **[Review]** Inbound webhooks verify the signature over the raw body with a constant-time comparison and a timestamp window; duplicates are rejected on `(provider, provider_event_id)`; unverified events are stored as unverified and change nothing.
- [ ] **[Review]** Providers that cannot sign (for example Surepass callbacks; confirmed gap, providers research §1) are treated as hints and confirmed by polling.
- [ ] **[Review]** Adapters declare `mock`, `sandbox` or `production` and are wired through `assertProviderAllowed()` (`packages/adapters/src/provider.ts`).
- [ ] **[Review]** Calls that process borrower data under a lender's licence use that lender's credentials and carry the consent record id.
- [ ] **[Review]** Outbound events to lender or ecosystem systems are signed at transport level (the CloudEvents envelope has no signature field) and contain no more personal data than the receiver needs.

### A-11 Encryption, storage and residency

- [ ] **[Review]** No new vendor, region, SaaS tool or SDK that stores or processes borrower data outside India without written approval (RBI storage-in-India rule: confirmed, secondary).
- [ ] **[Review] [Planned 06]** Lender-owned artefacts (KYC results, bureau reports, documents) are encrypted with that lender's KMS key.
- [ ] **[Review] [Planned 07]** KYC and loan documents are stored in S3 ap-south-1, never Supabase Storage (its CDN caches signed URLs globally after expiry: confirmed, infra research §3); presigned URLs are issued only after an authorisation check and expire within minutes.

### A-12 Dependencies and supply chain

- [ ] **[CI]** `pnpm audit --prod --audit-level high` passes, or the advisory is recorded in [`risk-acceptances.md`](risk-acceptances.md) and `package.json` `pnpm.auditConfig.ignoreGhsas` with an owner and review date.
- [ ] **[Review]** Each new dependency is justified in the PR: maintenance, licence, what it sends over the network, where it stores data, and (for mobile) which permissions its native code adds.
- [ ] **[Review]** No new dependency lifecycle script is allowed in `pnpm-workspace.yaml` `onlyBuiltDependencies` without review.
- [ ] **[Review]** GitHub Actions are pinned to a full commit SHA; workflow `permissions` stay minimal.
- [ ] **[Planned 03]** Container images pinned by digest; SBOM generated; SAST job (for example CodeQL or Semgrep) blocks high-severity findings (G-22).

### A-13 Code review for common API flaws

- [ ] **[Review]** The diff was read for: broken object-level authorisation, broken function-level authorisation, excessive data in responses, mass assignment, missing rate limits, server-side request forgery (no user-supplied URLs fetched by the server), unsafe redirects.
- [ ] **[Review]** Error responses are RFC 9457 problem+json with stable codes and no internals.

### A-14 Mobile app

- [ ] **[Review]** No new permission, `infoPlist` usage string or permission-adding plugin unless [`mobile-permissions.md`](mobile-permissions.md) is updated in the same PR and approved.
- [ ] **[Review]** `android.blockedPermissions` in `apps/mobile/app.config.ts` is unchanged or extended, never reduced.
- [ ] **[Review]** New native libraries and vendor SDKs: their Android manifest and iOS usage strings were checked (vendor SDKs often add prohibited permissions; see mobile-permissions.md §5).
- [ ] **[Planned 03]** CI fails if the merged AndroidManifest of the release build contains a permission not on the allowlist.
- [ ] **[Review]** Tokens only in `expo-secure-store`; no personal data in AsyncStorage or files; no tokens or OTPs in custom-scheme deep links.
- [ ] **[Review]** OTA updates stay disabled (`updates.enabled: false`) unless a signed-update policy has been approved; loan terms, consent text and permissions never change over the air.

### A-15 Portals

- [ ] **[Review]** No inline scripts or styles without the per-request nonce; no new external origin in the CSP (`apps/*/proxy.ts`) without review.
- [ ] **[Review]** No `dangerouslySetInnerHTML`; no tokens in `localStorage` or `sessionStorage`.
- [ ] **[Review]** Authenticated pages send `Cache-Control: no-store`.

### A-16 AI assistant (from Phase 09)

- [ ] **[Review]** The assistant's tools are on an allowlist, act with the borrower's own token, and include nothing that closes, rejects or settles a complaint or decides credit.
- [ ] **[Review]** Prompt or model changes re-run the prompt-injection test set; inference goes only to the approved India-hosted endpoint.

### A-17 Documentation

- [ ] **[Review]** [`threat-model.md`](threat-model.md) updated if the PR adds a component, data flow, trust boundary, provider or permission, or closes a gap (mark the G-nn row closed with the PR number).
- [ ] **[Review]** Regulatory statements keep their status labels and never claim compliance; affected rows in `docs/regulatory/controls-matrix.md` updated.

---

## B. Every release (staging and production)

Production releases also need the product owner's written approval.

| ID   | Gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Evidence to attach to the release record                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| B-1  | All section A gates pass on the release commit; the image promoted to production is the same digest that passed staging. **[Planned 03]** for digest promotion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | CI run link; image digest.                                                                                       |
| B-2  | Full test suite and pgTAP suite pass; migrations applied to staging (synthetic data only) before production.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | CI run; migration log.                                                                                           |
| B-3  | Dependency audit green or every exception accepted and in date in [`risk-acceptances.md`](risk-acceptances.md). SBOM archived (**[Planned 03]**).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Audit output; SBOM file.                                                                                         |
| B-4  | **Mobile permission audit of the merged manifest.** Build the release bundle and list its permissions (for example `bundletool dump manifest --bundle=app-release.aab`, or `aapt dump permissions` on an APK); compare with the allowlist in [`mobile-permissions.md`](mobile-permissions.md) §4. iOS: compare Info.plist usage-description keys with the allowlist and review the privacy manifest. Target API 36 on Android (required for new apps and updates from 31 Aug 2026: confirmed); Xcode 26 / iOS 26 SDK (required since 28 Apr 2026: confirmed).                                                                            | Permission list; Info.plist keys; build metadata.                                                                |
| B-5  | **Store-policy checks.** No product with full repayment within 60 days (Google Play and Apple: confirmed). On iOS, no offer above 36% APR including fees (Apple 3.2.2(ix): confirmed; whether to apply app-wide is owner decision D-19). Store listing names every live lender and shows tenure range and maximum APR (Play: confirmed / likely). Personal Loan App Declaration current. Each live lender has reported the app and it appears on RBI's public DLA list (Play India requirement: confirmed via Google Help extract). Data safety form and Apple privacy labels match the current SDK list. In-app account deletion works. | Listing diff (lenders in listing = live lenders in database); DLA directory evidence per lender; form snapshots. |
| B-6  | **Configuration and providers.** `APP_ENV` set explicitly; production refuses mock and sandbox providers (`assertProviderAllowed`); provider credentials are per lender and come from the secrets manager; Supabase Auth production settings (OTP limits, MFA, session limits, password rules) match the reviewed snapshot (G-25).                                                                                                                                                                                                                                                                                                       | Start-up log line with environment and provider modes; settings snapshot.                                        |
| B-7  | **Residency.** Every production resource (compute, database, storage, queues, logs, backups, analytics) is in ap-south-1, or ap-south-2 for DR; no new offshore vendor (RBI storage-in-India: confirmed, secondary). **[Planned 03]** automated infrastructure check.                                                                                                                                                                                                                                                                                                                                                                    | Infrastructure check output; vendor register.                                                                    |
| B-8  | **Logging and monitoring.** Logs and traces retained for at least 180 days in India; clocks synchronised to NIC/NPL NTP or traceable sources (CERT-In: likely). Canary PII scan clean. Alerts route to the on-call person.                                                                                                                                                                                                                                                                                                                                                                                                               | Retention configuration; scan output.                                                                            |
| B-9  | **Backups and restore drill.** Point-in-time recovery enabled; the last restore drill is within its cadence (recommendation: restore test every quarter, full DR drill every 6 months, research privacy §11); the drill restored to a new project, ran the pgTAP suite and verified `private.audit_digest()` against exported anchors; measured RPO/RTO recorded against the approved targets (owner decision D-28). Written confirmation from Supabase of where backups are stored (unverified today, infra research §3).                                                                                                               | Drill report with measured times.                                                                                |
| B-10 | **Incident response readiness.** On-call rota; CERT-In point of contact registered; incident runbook with the **6-hour CERT-In reporting clock** (likely); contractual notice to affected lenders (research recommends within 2 hours of detection so lenders can meet their own clocks: recommendation); DPDP breach notices to individuals and the Board with a detailed report within 72 hours once in force (likely; commencement around May 2027, a shorter timeline is unverified); tabletop exercise in the last 6 months (recommendation).                                                                                       | Runbook version; contact registration; tabletop record.                                                          |
| B-11 | **VAPT.** Before launch: vulnerability assessment and penetration test by a CERT-In-empanelled auditor covering API, portals and mobile (roadmap Phase 11). After launch: VA every 6 months and PT every 12 months, and after major changes (likely, as lender flow-down). No open critical or high finding; fix targets critical ≤ 7 days, high ≤ 30 days (recommendation).                                                                                                                                                                                                                                                             | Report; fix tracker.                                                                                             |
| B-12 | **Access review.** Staff with production, console, EAS or store access listed and confirmed; leavers removed; memberships without an expiry date reviewed; no shared accounts.                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Signed access list.                                                                                              |
| B-13 | **Regulatory verification.** Every regulatory reference shipped in this release (disclosures, KFS wording, consent text, policies, store declarations) has been verified against the primary text by counsel (owner decision D-05).                                                                                                                                                                                                                                                                                                                                                                                                      | Counsel sign-off.                                                                                                |
| B-14 | **Owner approval.** Written approval for production from the product owner; for a new lender, that lender's sign-off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Approval record.                                                                                                 |

---

## C. Incident response quick reference

| When                     | Action                                                                                                                                                         | Basis                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Detection (T0)           | Open an incident record; preserve logs and database state (no destructive clean-up); contain (revoke keys, disable the affected feature with its kill switch). | Good practice.                                                                     |
| T0 + 2 hours             | Notify affected partner lenders through the contractual channel.                                                                                               | Recommendation (privacy research §5), to be written into lender contracts.         |
| T0 + 6 hours             | Report to CERT-In if the incident is a reportable type (for example data breach or leak, unauthorised access, attack on applications, fake apps).              | CERT-In Directions 28 Apr 2022 (likely).                                           |
| Without delay / 72 hours | DPDP: notify affected individuals and the Data Protection Board; detailed report to the Board within 72 hours.                                                 | DPDP Rules (likely); in force around May 2027 unless brought forward (unverified). |
| As the lender requires   | Support the lender's own reporting to RBI.                                                                                                                     | Outsourcing rules: the lender notifies RBI of customer-data breaches (likely).     |
| Within 2 weeks           | Post-incident review; update [`threat-model.md`](threat-model.md) and this checklist.                                                                          | Good practice.                                                                     |

---

## D. Commands

```bash
pnpm install --frozen-lockfile
pnpm check                         # format:check, lint, typecheck, test
PGHOST=/tmp PGPORT=5432 PGUSER=postgres bash scripts/db-test-local.sh   # migrations + pgTAP, local Postgres 16+
supabase db start && supabase test db                                   # same on the Supabase stack (as in CI)
pnpm audit --prod --audit-level high                                   # dependency audit (as in CI)
APP_ENV=production pnpm --filter @udofin/mobile config:check           # mobile config resolves (as in CI)
```
