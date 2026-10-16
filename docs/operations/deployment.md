# Deployment and operations

Date: 2026-10-10. Covers environments, hosting, configuration and secrets, the deployment
pipeline, database migrations, rollback, backup and restore, disaster recovery, monitoring, incident
response and the production-readiness checklist.

> **Status: nothing has been deployed.** No hosted environment has been created or changed from this
> repository. The migrations have been tested only on a local PostgreSQL 16 instance
> (`scripts/db-test-local.sh`). The CI workflow `.github/workflows/ci.yml` exists but has not yet
> run on GitHub. There is no deployment workflow and no infrastructure as code yet (`infra/`
> contains only `README.md` and `docker/api.Dockerfile`). Everything below marked **planned** is the
> target design, built mainly in Phase 03 and proven in Phase 11 ([`../product/roadmap.md`](../product/roadmap.md)).

> **Research limitation.** Regulatory timelines below (CERT-In, RBI, DPDP) come from
> `docs/research/2026-10-10/`. The sandbox could not open primary sources during research, so they
> rest on search snippets and secondary sources and carry status labels (confirmed / likely /
> interpretation / unverified). They must be verified against the primary text before being relied
> on in contracts or runbooks (decision D-05 in [`../product/open-decisions.md`](../product/open-decisions.md)).

Related decisions: hosting and residency [ADR 0010](../adr/0010-hosting-and-data-residency.md);
background jobs [ADR 0011](../adr/0011-background-jobs-outbox-pg-boss.md); mobile OTA policy
[ADR 0016](../adr/0016-mobile-expo-permissions-and-ota-policy.md). Open owner decisions: D-06 (AWS
account), D-07 (Supabase plan and PITR), D-28 (regional DR posture).

---

## 1. Environments

| Environment    | Purpose                                                     | Data allowed         | Database and auth                                                                                                                                     | Compute                                                                                             | Files                                                                                               | Who deploys                               | Status                                                |
| -------------- | ----------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| **local**      | Developer machine; tests                                    | Synthetic only       | Supabase CLI local stack (`supabase/config.toml`; API on port 54321, Postgres on 54322) or local PostgreSQL with `scripts/db/local-supabase-shim.sql` | API on :8080, ops portal on :3001, lender portal on :3002, mobile development build                 | Local only                                                                                          | Developer                                 | Available                                             |
| **dev**        | Integration of merged work                                  | Synthetic only       | Supabase project in ap-south-1 (one per environment, D-07)                                                                                            | Railway (no India region; synthetic data only) or AWS, per D-06                                     | Non-production bucket with synthetic files                                                          | CI on merge to `main`                     | Planned (Phase 03)                                    |
| **staging**    | Release candidate testing, lender demos, provider sandboxes | Synthetic only       | Separate Supabase project in ap-south-1                                                                                                               | Same as dev                                                                                         | Separate non-production bucket                                                                      | Promotion of the dev image after approval | Planned (Phase 03)                                    |
| **production** | Real borrowers and lenders                                  | Real data, minimised | Supabase project in ap-south-1 (existing `Udofin-app` project or a new one, per D-07), PITR enabled                                                   | AWS ap-south-1: ECS on Fargate for API, worker and portals behind a regional load balancer with WAF | S3 ap-south-1 with SSE-KMS, versioning, Block Public Access; Object Lock for audit and log archives | Pipeline with your explicit approval      | Planned (Phase 03 skeleton; live only after Phase 11) |

**Data rules.**

- Outside production, **synthetic data only**. No real borrower or lender data, no copies or
  extracts of production data, no "anonymised" production dumps. Test phone numbers and test
  identities are designated in advance.
- Production data never leaves India. Every store that may hold borrower data (database, files,
  queues, logs, traces, backups, support tooling) is in an Indian region. Railway regions are all
  outside India (confirmed; `infra-stack.md` §1), so Railway never holds production data.
- Restore drills (section 7) run inside the production account in ap-south-1, are access-controlled
  like production, and are destroyed afterwards.

**Environment names in code.** `services/api/src/config.ts` and `packages/adapters/src/provider.ts`
currently know `local`, `test`, `staging` and `production`; the mobile EAS profiles in
`apps/mobile/eas.json` are `development` (APP_ENV=local), `preview` (APP_ENV=staging) and
`production`. Phase 03 adds a `dev` value (allowed provider modes: mock and sandbox) or runs dev
with the staging profile; this is decided in the Phase 03 spec. Non-production mobile builds use a
different application identifier (`com.udofin.app.<env>`), so a test build cannot be confused with
the production app. Mocks and sandbox providers are refused in production by
`assertProviderAllowed`.

## 2. Hosting per environment

| Component                                  | local                            | dev / staging                                                                       | production                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres + Auth                            | Supabase CLI or local PostgreSQL | Supabase, ap-south-1                                                                | Supabase, ap-south-1 (Team plan recommended, D-07); read replicas, if any, only in ap-south-1                                                                                            |
| API, worker                                | Node 24 locally                  | Container from `infra/docker/api.Dockerfile` on Railway or AWS                      | ECS on Fargate, ap-south-1 (AWS App Runner is closed to new customers; confirmed)                                                                                                        |
| Ops and lender portals                     | `next dev`                       | Container (Next.js standalone output)                                               | ECS on Fargate, ap-south-1                                                                                                                                                               |
| Documents (KYC artefacts, KFS, agreements) | Local                            | Non-production bucket, synthetic files                                              | S3 ap-south-1, SSE-KMS with per-lender keys, short-lived pre-signed URLs issued by the API, no CDN. Not Supabase Storage (its Smart CDN caches signed-URL responses globally; confirmed) |
| Keys and secrets                           | `.env` from `*.env.example`      | Secrets store of the hosting provider (Railway sealed variables if Railway is used) | AWS KMS and Secrets Manager, ap-south-1                                                                                                                                                  |
| Logs, metrics, traces                      | Console                          | India-hosted collector where possible; never personal data                          | OpenTelemetry collector and backend in ap-south-1 (CloudWatch or self-hosted Grafana stack); at least 180 days retention in India; archive to S3 with Object Lock                        |
| Edge Functions                             | Not used                         | Not used, or pinned to ap-south-1                                                   | Not used, or pinned to ap-south-1 (they otherwise run nearest the caller; confirmed)                                                                                                     |
| AI inference                               | Mock                             | Sandbox, no personal data                                                           | India-hosted inference (D-18)                                                                                                                                                            |
| Disaster recovery                          | —                                | —                                                                                   | ap-south-2 (Hyderabad) later, per D-28                                                                                                                                                   |

## 3. Configuration and secrets

- **Only example files are committed**: `services/api/.env.example`, `apps/mobile/.env.example`,
  `apps/ops-portal/.env.example`, `apps/lender-portal/.env.example`. Each contains placeholders
  only. `.gitignore` blocks `.env` files, keys, keystores and data dumps. CI runs a gitleaks secret
  scan on every pull request.
- **Validated at start-up**: the API refuses to start on invalid configuration
  (`services/api/src/config.ts`): deployed environments require `DATABASE_URL` and `SUPABASE_URL`;
  CORS origins must be explicit and https when deployed; `trace` logging is refused in production.
  Error messages name variables but never echo values.
- **Public versus secret**: anything prefixed `EXPO_PUBLIC_` or `NEXT_PUBLIC_` is shipped to devices
  or browsers and is public. Clients receive only the Supabase publishable key, which is safe
  because domain schemas are not exposed through the Data API and RLS is enforced.
- **Where secrets live**: production secrets in AWS Secrets Manager (encrypted with KMS,
  ap-south-1); non-production secrets in the hosting provider's secret store. Deployments
  authenticate with GitHub OIDC (no long-lived cloud keys in GitHub).
- **Privilege separation**: the API connects with a restricted database role, never the
  `postgres` superuser and never `service_role`. `service_role` is used only by worker code paths.
- **Per-lender provider credentials** (merchant, mandate, KYC, bureau, AA, eSign) are stored in the
  secrets manager and referenced by ID from the database (Phase 04). Every read is audited.
- **Rotation**: every secret has an owner and a rotation date; rotation of live credentials needs
  your explicit approval; rotate immediately after any suspected exposure or staff departure.

## 4. Deployment pipeline

**Continuous integration (exists, not yet run).** `.github/workflows/ci.yml` runs on every pull
request and on `main`: format check, build, lint, typecheck, unit tests; production mobile config
check; dependency audit (high and critical); migrations and pgTAP tests on the Supabase stack
(Postgres 17); gitleaks secret scan; API container build. Dependabot opens weekly update pull
requests; TypeScript 6.1+ is held back (ADR 0002).

**Planned additions (Phase 03).** Merged-AndroidManifest permission check on the release build;
migration lint (RLS enabled and forced on new domain tables, explicit grants); image publishing with
immutable tags to a registry in ap-south-1; deployment workflows.

**Continuous delivery (planned).**

1. Merge to `main` (after your approval of the pull request).
2. CI builds images once; each image is identified by its digest.
3. **dev**: automatic deployment; database migrations applied first, then worker, API and portals.
4. **staging**: the same digests promoted after a recorded approval; smoke and end-to-end tests
   against provider sandboxes.
5. **production**: only with your explicit approval and a completed release checklist. Order:
   confirm PITR is active and note the timestamp; apply migrations (expand step only); deploy
   worker; deploy API; deploy portals. Each step waits for `/health/ready`; if health checks fail,
   the rollout stops and the previous version keeps serving.
6. Every production deployment is recorded (who approved, digests, migration versions, time).

**Mobile (planned).** EAS Build profiles `development`, `preview`, `production` (`apps/mobile/eas.json`;
production builds an Android App Bundle with remote version numbering). Release path: Play internal
testing, then closed testing, then production with a staged percentage rollout. iOS follows Android
(D-19). Over-the-air updates are disabled (`updates.enabled: false` in `apps/mobile/app.config.ts`);
if enabled later they must be code-signed and must never change loan terms, APR or KFS logic,
consent text, permissions or data collection (ADR 0016). Store submission happens only after each
launch lender has reported the app on CIMS and it appears on RBI's public list (confirmed via
Google Help Center extract; `app-store-mobile.md` §1.2).

## 5. Database migration procedure

The schema source of truth is `supabase/migrations/` (SQL-first). Review rules are in
`docs/data/migrations.md`.

1. **Write** a new timestamped migration file. Never edit a migration that has been applied to any
   shared environment (dev, staging, production). Local databases can be reset freely.
2. **Design for backward compatibility** (expand, then contract): add new columns, tables and
   functions first; deploy code that works with both old and new schema; remove old structures in a
   later release. This keeps application rollback possible without a database rollback.
3. **Security checks** in the same pull request: RLS enabled and forced on new domain tables;
   `lender_org_id` and composite foreign keys on tenant-owned rows; explicit, column-level grants;
   append-only triggers where history must not change; no personal data without an entry in
   `docs/data/ownership.md`.
4. **Tests**: pgTAP tests for the change, including negative and cross-tenant cases; the whole suite
   passes locally and in CI.
5. **Review**: you approve the pull request; migrations touching money, consent, audit or tenancy
   get a second review when a second engineer is available (`.github/CODEOWNERS`).
6. **Apply** in order dev → staging → production, through the pipeline only. Before production:
   confirm PITR is active and record the restore point; estimate lock impact on large tables.
7. **Verify** after applying: read-only structural checks (RLS status, grants), `private.audit_digest()`
   tamper check, application health.
8. **Forward-only in shared environments.** A faulty migration is corrected by a new migration. A
   destructive mistake in production is handled as an incident with a point-in-time restore
   (section 7).
9. Data migrations (backfills) are separate, idempotent and resumable, and never mixed with schema
   changes in one file.
10. Reference data that changes behaviour (for example `lending.product_categories`) changes only
    through a reviewed migration.

## 6. Rollback procedures per component

| Component                                                     | How to roll back                                                                                                                                               | Notes                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API container                                                 | Redeploy the previous image digest (previous task definition).                                                                                                 | Works without database rollback because migrations are backward compatible (expand/contract).                                                                                                                                                |
| Worker                                                        | Pause the affected queues, redeploy the previous digest, resume.                                                                                               | Handlers are idempotent; jobs that ran twice cause no duplicate effect. Disbursement or payment calls are never retried on timeout without a status enquiry first.                                                                           |
| Ops and lender portals                                        | Redeploy the previous digest.                                                                                                                                  | Stateless.                                                                                                                                                                                                                                   |
| Mobile store builds                                           | Halt the staged rollout in Play Console; ship a fixed build with a higher version code. A published binary cannot be withdrawn from devices that installed it. | Server-side kill switches (per lender, per product, per feature) and a minimum-supported-version check in the API stop a faulty build from doing harm. Plan these in Phase 03.                                                               |
| Mobile OTA updates                                            | Disabled today. If enabled later, republish the previous signed update.                                                                                        | Only for changes allowed by ADR 0016.                                                                                                                                                                                                        |
| Database schema                                               | Forward fix with a new migration.                                                                                                                              | No down-migrations in shared environments.                                                                                                                                                                                                   |
| Database data (corruption, bad backfill, destructive mistake) | Point-in-time restore (section 7), then reconciliation (section 8.3).                                                                                          | Declared as an incident. Udofin is a read model of lender systems, so loan data can be re-synced from each lender's LMS and payment data from provider reports; consent, audit and complaint records cannot, which is why PITR is mandatory. |
| Configuration and secrets                                     | Restore the previous secret version; redeploy.                                                                                                                 | Every change recorded.                                                                                                                                                                                                                       |
| Infrastructure                                                | Re-apply the previous IaC version.                                                                                                                             | Region allowlist enforced on every apply.                                                                                                                                                                                                    |

## 7. Backup and restore

**A backup is not proven until it has been restored.** Every backup mechanism below has a restore
drill with recorded results.

| What                                                | Mechanism                                                                                                                                                                                                                       | Retention                                                                                                                    | Status   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------- |
| Postgres (domain data, Supabase Auth users, queues) | Supabase PITR add-on: 7, 14 or 28 days at about $100, $200 or $400 per month; needs at least Small compute; worst-case RPO about 2 minutes; replaces daily backups when enabled (confirmed, Supabase docs; `infra-stack.md` §3) | 14 days recommended (D-07)                                                                                                   | Planned  |
| Postgres regional copy                              | Encrypted daily logical export to S3 in ap-south-2 (proposed, if D-28 option (a) is chosen)                                                                                                                                     | 35 days (proposed)                                                                                                           | Proposal |
| Documents                                           | S3 versioning; Object Lock where records must not change; replication to ap-south-2 later (D-28)                                                                                                                                | Per retention schedule (D-25)                                                                                                | Planned  |
| Audit and log archives                              | S3 with Object Lock (write once)                                                                                                                                                                                                | At least 180 days in India for logs (CERT-In, likely); research recommends 1 year hot plus 2 years archive for security logs | Planned  |
| Infrastructure and configuration                    | IaC and configuration in Git; secret versions in Secrets Manager                                                                                                                                                                | Indefinite (Git)                                                                                                             | Planned  |

**Residency of backups.** The region of Supabase's backup storage and platform logs is not
documented (unverified). Obtain Supabase's written confirmation before production (D-07).

**Restore drill (quarterly, and before launch).**

1. Pick a timestamp T. Restore the production database to T into an isolated, access-controlled
   project in ap-south-1. (Confirm in the first drill whether Supabase restores in place or into a
   new project; plan for the safer option.)
2. Run the pgTAP structural tests and the `private.audit_digest()` tamper check; compare row
   counts and the latest audit anchors against production at T.
3. Run the reconciliation job (section 8.3) against lender LMS and provider sandboxes or reports.
4. Record actual data loss (achieved RPO) and elapsed time (achieved RTO) against the targets in
   section 8.1; record problems and fixes.
5. Destroy the restored project; record evidence (who, when, results).

## 8. Disaster recovery

### 8.1 Proposed recovery targets (for your approval, D-28)

These are proposals, not measured results. They become commitments only after a successful drill.

| Scenario                                                     | Proposed RPO (data loss)                                  | Proposed RTO (time to restore service)                                                          | How                                                                                                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Faulty application release                                   | None                                                      | 30 minutes                                                                                      | Redeploy previous digest                                                                                                                                              |
| Faulty migration or data corruption                          | 5 minutes or less                                         | 4 hours                                                                                         | PITR restore and reconciliation                                                                                                                                       |
| Loss of a third-party provider (SMS, payment gateway, eSign) | None                                                      | Degraded mode immediately; full service when the provider recovers or a fallback is switched on | Queues hold work; borrower sees clear status; fallback providers where contracted                                                                                     |
| Supabase project unavailable                                 | 5 minutes or less                                         | Dependent on Supabase; 8 hours target for a documented rebuild into a new ap-south-1 project    | PITR or latest backup                                                                                                                                                 |
| Loss of the Mumbai region                                    | 24 hours or less (daily export to ap-south-2, if adopted) | 72 hours (manual rebuild in ap-south-2)                                                         | Supabase offers only ap-south-1 in India (likely), so no warm standby in India on Supabase; a later move to Aurora with a Hyderabad replica would improve this (D-28) |

### 8.2 Queue recovery

- Jobs live in Postgres (pg-boss), so they are restored with the database. Jobs that were running
  at the moment of failure may run again; every handler is idempotent, keyed on aggregate and event
  identifiers.
- Outbox rows not yet published are re-published after recovery; consumers de-duplicate on event
  ID (CloudEvents envelope in `packages/contracts`).
- Calls to providers and lenders carry idempotency keys. For disbursement and payment status,
  query the provider or lender first; never re-send a money instruction on timeout without a status
  enquiry.
- Review the dead-letter queue item by item after any outage; nothing is bulk-replayed without
  checking.

### 8.3 Reconciliation after an outage or restore

Define the affected window (outage start to recovery, or restore point to recovery). Then:

1. Pause borrower-facing money actions (pay-now links, mandate creation, offer acceptance) with the
   kill switches until reconciliation completes.
2. Re-fetch provider events and settlement reports for the window; re-apply verified events
   (duplicates are rejected by `payments.provider_events`).
3. Re-sync loan status and schedules from each lender's LMS for loans with activity in the window.
4. Resolve payment intents left in `created` or `pending` against provider records; only the system
   moves them to a final state.
5. Check consent and audit integrity (`private.audit_digest()`, anchors). Identify comparison
   displays, KFS acknowledgements or consents lost in a data-loss window; where needed, ask the
   borrower to see or confirm them again.
6. Send each affected lender a list of affected applications, loans and payments.
7. Record everything in the incident record.

## 9. Monitoring, SLOs and alerting

All targets below are **proposed** for your approval; they are not yet measured. Telemetry is
stored in India and contains no personal data.

| Signal                                              | Proposed objective                                                                                                                            | Alert when                                                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API availability (borrower and portal endpoints)    | 99.5% per month                                                                                                                               | Error budget burn rate high over 1 hour                                                                                                                       |
| API latency                                         | p95 below 500 ms for reads; p95 below 1,000 ms for writes (excluding time waiting on providers)                                               | p95 above target for 15 minutes                                                                                                                               |
| Integration failure rate (per provider, per lender) | Below 2% failed calls                                                                                                                         | Above 5% over 15 minutes, or any authentication failure                                                                                                       |
| OTP delivery                                        | Send SMS hook completes within its 5-second budget (confirmed limit, Supabase docs)                                                           | Hook timeouts or fallback use above baseline                                                                                                                  |
| Queue delay                                         | Oldest job in critical queues (payments, decision intake, notifications) younger than 2 minutes                                               | Older than 5 minutes; any job in the dead-letter queue                                                                                                        |
| Reconciliation lag                                  | Verified provider event reflected in payment status within 5 minutes; daily settlement reconciliation complete by 10:00 IST next business day | Unreconciled item older than 24 hours                                                                                                                         |
| LMS sync lag                                        | Lender status changes visible within 60 minutes                                                                                               | Older than 2 hours for any lender                                                                                                                             |
| Security signals                                    | —                                                                                                                                             | Any webhook signature failure burst; spike in authorisation denials; any `service_role` use outside worker code; `private.audit_digest()` mismatch (critical) |
| Compliance signals                                  | —                                                                                                                                             | A lender's DLA listing evidence missing or expired; complaint without final reply by day 25; DLG accounts at 90, 110 and 120 days overdue (if DLG is adopted) |

**Alerting without personal data.**

- Logs, metrics, traces and alerts carry only identifiers: request ID, organisation (tenant) ID,
  job ID, provider key, error code. Never names, phone numbers, email addresses, PAN, Aadhaar,
  OTPs or account numbers. The API logger already redacts these (`services/api/src/logger.ts`).
- Alert messages link to a dashboard or record by ID; the responder looks up details inside the
  access-controlled system.
- No offshore error-tracking SaaS for anything that may contain personal data (Sentry SaaS stores
  data in the US or EU; confirmed, `infra-stack.md` §9).
- Clocks synchronised to an approved time source and logs kept in UTC with offset (CERT-In; likely).

## 10. Incident response

**Roles.** Incident lead (named by D-12), communications owner, scribe. Each lender contract names a
lender contact for incident notifications.

**Severity.**

| Severity | Examples                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| SEV-1    | Personal data exposure; money sent to a wrong account; tenant isolation failure; audit tamper alert; production down |
| SEV-2    | One lender or one provider integration down; reconciliation stuck; complaint routing failing                         |
| SEV-3    | Degraded performance; non-critical feature failure                                                                   |

**Clocks (from when the incident is noticed).**

| When                                                        | Action                                                                              | Source                                                                                                                                                                            | Status                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Within 2 hours                                              | Notify every affected lender                                                        | Research recommendation, so lenders can meet their own RBI reporting (lenders report cyber incidents on DAKSH within 6 hours under the 31 Jul 2026 NBFC cybersecurity directions) | Recommendation; lender 6-hour rule likely       |
| Within 6 hours                                              | Report listed incident types to CERT-In through the registered point of contact     | CERT-In Directions under s.70B(6) IT Act, 28 Apr 2022                                                                                                                             | Likely (primary not read)                       |
| Without delay; detailed report to the Board within 72 hours | Notify affected individuals and the Data Protection Board of a personal-data breach | DPDP Act 2023 s.8(6) and DPDP Rules 2025 r.7 — obligations commence about 13/14 May 2027 (a shorter timeline was consulted on; unverified)                                        | Confirmed timing per research; not yet in force |
| Lender's obligation                                         | Lender notifies RBI of breaches of customer data                                    | RBI outsourcing rules (flow-down)                                                                                                                                                 | Likely                                          |

**Steps.**

1. Detect and declare (anyone can declare; the incident lead confirms severity).
2. Contain: kill switches, credential rotation (with your approval for live credentials), block
   affected integrations.
3. Preserve evidence: logs (180 days in India), audit events, configuration history; do not alter
   records.
4. Notify per the clocks above; borrower communication about lender-owned data goes through or with
   the lender.
5. Recover: rollback or restore (sections 6 and 7); reconcile (section 8.3).
6. Review within 5 business days (proposed): timeline, root cause, actions, control updates,
   update of `docs/security/` and this document.

**Practice.** Tabletop exercise every 6 months, including the 6-hour CERT-In clock (research
recommendation; `privacy-security-outsourcing.md`).

## 11. Production-readiness checklist

All items must be ticked, with evidence linked, before the first real borrower. You sign off the
final list.

**Lenders and legal**

- [ ] Each launch lender's contract signed, including outsourcing, audit and inspection, data
      protection, incident notification and exit clauses (D-03).
- [ ] Each launch lender has reported the Udofin app (and any web front end) on CIMS; the listing is
      visible on RBI's public DLA list; dated evidence stored.
- [ ] Each lender's website lists Udofin as its LSP.
- [ ] Counsel has verified every regulatory reference used in disclosures, KFS templates, consent
      text and contracts against primary sources (D-05).
- [ ] Udofin's grievance officer, privacy contact and CERT-In point of contact appointed and
      published (D-12).

**Infrastructure and data residency**

- [ ] All production resources in ap-south-1 (or ap-south-2 for DR); region allowlist check passes.
- [ ] Supabase's written confirmation of backup and log residency on file (D-07).
- [ ] Finbyx project moved to Mumbai (D-04) before any Finbyx integration carries real data.
- [ ] PITR enabled; restore drill passed with achieved RPO/RTO recorded.
- [ ] Logs retained at least 180 days in India; archive with Object Lock; clocks synchronised.
- [ ] No personal data in logs, traces, alerts or push payloads (automated injection test).

**Security**

- [ ] VAPT by a CERT-In-empanelled auditor (web, API, mobile) with no open critical or high
      findings.
- [ ] Second factor enforced for all staff; access reviews done; least-privilege roles.
- [ ] `service_role` used only by worker code; API uses the restricted role.
- [ ] Authorisation-matrix and cross-tenant tests pass on Postgres 17.
- [ ] Secrets only in the secrets manager; rotation owners and dates recorded.
- [ ] Release build's merged AndroidManifest contains no banned permission.
- [ ] Device integrity verified server-side on high-risk actions (D-24).

**App store**

- [ ] Personal Loan App Declaration filed with lender evidence; developer account in the legal
      entity's name (D-02, D-08).
- [ ] Store listing names all live lenders and shows minimum and maximum repayment period and
      maximum APR; matches the database (automated diff).
- [ ] Data safety form matches the data inventory, including SDKs.
- [ ] Target API 36; in-app account deletion works.

**Operations**

- [ ] Dashboards and alerts for every signal in section 9; alerts routed to an on-call rota.
- [ ] Runbooks for rollback, restore, reconciliation and incident response tested.
- [ ] Incident tabletop completed, including the 6-hour clock.
- [ ] Kill switches per lender, product and feature tested; minimum-supported-app-version check
      tested.
- [ ] Reconciliation jobs running in staging with zero unexplained differences for 2 weeks
      (proposed).

**Product controls (evidence, not claims of compliance)**

- [ ] Comparison screen tests pass (all matching offers, mandatory fields, lenders that did not
      offer named, neutral order, displays logged).
- [ ] KFS acknowledged before eSign; expiry enforced; cooling-off shown.
- [ ] Complaint flow reaches a human; RB-IOS details and deadline in every final reply.
- [ ] Consent ledger records every consent with notice version and hash; marketing consent
      optional.
- [ ] Repayments settle only to lenders' accounts; reconciliation shows no Udofin-held funds.

**Rollout**

- [ ] Rollout plan approved: internal testing, closed testing, staged percentages, one lender at a
      time, with go/no-go metrics.
- [ ] Your written approval for production.
