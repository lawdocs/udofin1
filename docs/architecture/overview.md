# Udofin architecture overview

|                     |                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status              | Baseline, written in Phase 01 (Repository audit & architecture), 2026-10-10. Status labels refreshed against the code on 14 October 2026 (see the note below)        |
| Covers              | System context, containers, deployment, modules, request path, database access modes, money flow and system-of-record principles, end-to-end loan journey            |
| Audience            | Product owner (each section opens in plain English) and engineers (details and code paths follow)                                                                    |
| Companion documents | [`ecosystem.md`](ecosystem.md) (Udofin, Finbyx, LawDocsComply, Equator), [`../data/ownership.md`](../data/ownership.md) (data ownership and classification register) |

> **Refresh of 14 October 2026.** The "Built / Planned" statements in sections 0, 3, 4, 5, 6, 7, 8, 9 and 11 were checked against the code and corrected where they had gone stale (the baseline pre-dates phases 02 to 07). The independent view is in [`phase-02-architecture-verification.md`](phase-02-architecture-verification.md), which also lists what is **not** built and what was **not** verified (nothing is deployed; no hosted Supabase project, provider or device was inspected). Test counts are deliberately not repeated here: see [`../testing/strategy.md`](../testing/strategy.md).

> **Regulatory content: read before relying on it.** During research the sandbox could not open rbi.org.in or other primary sources (WebFetch DNS failure; the proxy blocked HTTPS), and the shared web-search budget (200 per turn) ran out. Regulatory findings therefore rest on search snippets and secondary sources (law firms, press). This document keeps the research status labels: **confirmed**, **likely**, **interpretation**, **unverified** (plus **recommendation** where the research proposes a practice rather than reporting a rule). Every regulatory paragraph reference must be verified against the primary RBI, UIDAI, MeitY or NPCI text before anyone relies on it in a contract, policy or launch decision. **This verification is a release gate.** Nothing here states that Udofin "is compliant"; it states which control exists, what evidence it produces and what still has to be verified.

---

## 0. How to read status

- **Built**: exists in the repository and is covered by tests (pgTAP for the database, run locally on PostgreSQL 16 and in CI on the Supabase CLI with Postgres 17; Vitest for the TypeScript packages, the API and the portals' components; API integration tests against a migrated database; browser tests for the portals). Current counts and what each layer covers: [`../testing/strategy.md`](../testing/strategy.md). "Built" does not mean deployed or run against a real provider; nothing is deployed.
- **Planned (Phase N)**: decided, not implemented. "Decided" means it is recorded in the baseline decisions; it does not mean it has been designed in detail.

| Phase | Name                                                           |
| ----- | -------------------------------------------------------------- |
| 01    | Repository audit & architecture (this baseline)                |
| 02    | Database & security foundation                                 |
| 03    | Application foundation (auth, API platform, portals shell, CI) |
| 04    | Lender onboarding & configuration                              |
| 05    | Borrower onboarding & loan request                             |
| 06    | Verification, decisions & offers                               |
| 07    | Documents, KFS, eSign/eStamp & disbursement                    |
| 08    | Servicing, payments, mandates & collections                    |
| 09    | Grievance, AI support & Equator referral                       |
| 10    | Finance, accounting, reporting & ecosystem integrations        |
| 11    | Hardening & launch                                             |

---

## 1. Udofin in one paragraph

Udofin is a **Lending Service Provider (LSP)**. It runs a borrower app (a Digital Lending App, DLA) and two web portals so that a borrower can ask several partner lenders for a loan at once, compare their offers side by side, and complete the chosen lender's process. Three things Udofin is **not**:

1. **Not the lender.** The regulated lender (the "RE") makes the credit decision, owns KYC and bureau checks, issues the Key Facts Statement (KFS) and the loan agreement, and disburses. Udofin orchestrates screens and integrations on the lender's behalf.
2. **Not the loan system of record.** The lender's loan management system (LMS), which may be Finbyx or a third-party system, owns balances, schedules, receipt allocation, accrual, provisioning and accounting. Udofin keeps an immutable copy of what the LMS reports and reconciles against it.
3. **Not in the money flow.** Disbursements go from the lender's account to the borrower's verified account. Repayments go from the borrower to the lender's account, using the lender's own payment credentials. Udofin has no pool or pass-through account.

---

## 2. System context

**Plain English.** Who uses Udofin, and which outside systems it talks to. Everything in the "lender rails" box runs under the lender's contracts, licences and credentials; Udofin only operates the screens and the integration code.

### 2.1 Actors

| Actor                   | Uses                                   | What they do                                                                                                                                                                    | Access model                                                                                                                   | Status                                                                                                     |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Borrower                | Mobile app (web servicing pages later) | Signs up with phone OTP, creates a loan request, consents to share it with named lenders, compares offers, accepts one, completes the lender's KYC/KFS/eSign, repays, complains | Sees only own records (RLS on `borrower_id`)                                                                                   | Database rules and app flows through acceptance Built (Phases 05 to 07); the app has never run on a device |
| Lender staff            | Lender portal                          | Configure products (maker-checker), review applications, record decisions, issue and withdraw offers, view loans and payments of their own organisation                         | System roles `lender_admin`, `credit_officer`, `product_approver`, `viewer`; data limited to own `lender_org_id`               | Roles, RLS and portal screens for onboarding, products, applications, the panel and KFS documents Built    |
| Udofin operations staff | Ops portal                             | Handle exceptions across lenders, read-only                                                                                                                                     | Role `operations_agent`; reads lender data only through `platform_grantable` permissions; each access to be audited by the API | Roles and RLS Built; API audit of platform-staff access not verified as built on 14 Oct 2026               |
| Platform admin          | Ops portal                             | Onboard, suspend and offboard organisations; publish consent notice versions                                                                                                    | Role `platform_admin` with platform-only permissions                                                                           | Roles Built; workflows Planned (Phase 4)                                                                   |
| Auditors                | Ops portal; lender portal              | Udofin internal audit reads records and the audit trail. Lender auditors (and RBI, through the lender's contract) need read access to evidence                                  | Platform role `auditor`; lender-side auditor access Planned                                                                    | Platform role Built; lender auditor access Planned (Phase 4)                                               |
| Field agent (later)     | Assisted-onboarding app                | Captures a borrower's decisions in person                                                                                                                                       | Schema already allows `consent.channel = 'assisted'` with `captured_by`; borrower self-service inserts cannot use it           | Deferred until a lender needs assisted onboarding                                                          |
| Service-partner staff   | Lender portal                          | For example a collection agency engaged by a lender                                                                                                                             | Organisation kind `service_partner` exists                                                                                     | Planned (Phase 8)                                                                                          |

### 2.2 External systems

| External system                                                                                                                                      | Purpose                                                     | In whose name                                                                                                                                                  | Udofin's role                                                                                                           | Status                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Lender LOS/LMS: Finbyx, a third-party LMS, or manual import                                                                                          | Applications, decisions, loan accounts, schedules, receipts | Lender                                                                                                                                                         | Integrates through an adapter; keeps a read-model (`servicing.source_system` = `finbyx`, `lender_lms`, `manual_import`) | Read-model Built; adapters Planned (Phase 6 to 8)       |
| KYC: DigiLocker, CKYC registry, PAN verification, Aadhaar (through the lender's AUA/KUA or its KYC provider), bank-account verification (penny drop) | Customer due diligence                                      | Lender (per research, the RE, not the LSP, is the legal user of these rails; see `docs/research/2026-10-10/kyc-aadhaar-bureau.md` for the status of each rule) | UI and orchestration; results stored only in lender-scoped encrypted storage                                            | Planned (Phase 6)                                       |
| Credit bureaus                                                                                                                                       | Credit reports                                              | Lender's bureau membership                                                                                                                                     | No Udofin "soft pull" in its own name; receives only the lender's outcome                                               | Planned (Phase 6)                                       |
| Account Aggregators                                                                                                                                  | Consented financial data                                    | Lender as FIU [likely]                                                                                                                                         | Technology service provider                                                                                             | Planned (Phase 6)                                       |
| eSign (CCA-licensed ESP, through an aggregator) and eStamp (SHCIL / NeSL DDE through aggregators)                                                    | Execution of KFS acknowledgement and loan documents         | Lender                                                                                                                                                         | Runs the signing workflow as the lender's agent                                                                         | Planned (Phase 7)                                       |
| Payment aggregators (Razorpay, Cashfree, PayU, Juspay), eNACH and UPI AutoPay mandates, BBPS, virtual accounts                                       | Repayment collection                                        | Lender's own merchant and mandate credentials; settles to the lender's account                                                                                 | Creates payment instructions, consumes webhooks for status and reconciliation                                           | Payment-intent schema Built; adapters Planned (Phase 8) |
| Depositories and RTAs (NSDL/CDSL; CAMS, KFintech, MF Central)                                                                                        | Pledge or lien for loans against securities or mutual funds | Lender as pledgee or lien holder                                                                                                                               | Orchestration only                                                                                                      | Product category in `feasibility_review`; not scheduled |
| SMS (DLT-registered providers) and push (Expo to FCM/APNs)                                                                                           | OTP, transactional messages, reminders                      | Udofin as sender for login OTP; loan-servicing messages should name the lender (research recommendation)                                                       | Sender; no personal data in push payloads                                                                               | Planned (Phase 5 OTP, later phases for others)          |
| Accounting exports (Tally, SAP)                                                                                                                      | Udofin's own books; lender exports where asked              | Book owner                                                                                                                                                     | Export destination only, never a ledger                                                                                 | Planned (Phase 10)                                      |
| LawDocsComply                                                                                                                                        | Compliance evidence and metrics, per legal entity           | Each tenant entity                                                                                                                                             | Sends evidence events with IDs and metrics, no borrower personal data                                                   | Planned (Phase 10)                                      |
| Equator                                                                                                                                              | Optional, post-dispute, opt-in dispute resolution           | Equator as independent data fiduciary                                                                                                                          | Borrower-initiated referral with a one-time consent token                                                               | Planned (Phase 9)                                       |
| RBI Ombudsman complaint portal                                                                                                                       | Escalation route for borrowers                              | RBI                                                                                                                                                            | Link and deadline information only; no integration                                                                      | Planned (Phase 9)                                       |
| AI inference (India-hosted, for example Amazon Bedrock India geo inference per research)                                                             | Assistive support only                                      | Udofin                                                                                                                                                         | Caller; transcripts kept as records                                                                                     | Planned (Phase 9)                                       |

### 2.3 Context diagram

```mermaid
flowchart LR
  borrower(["Borrower"])
  lstaff(["Lender staff"])
  ops(["Udofin operations staff"])
  admin(["Udofin platform admin"])
  auditor(["Auditors<br/>Udofin internal, lender, RBI via lender"])
  field(["Field agent<br/>deferred"])

  udofin["Udofin platform<br/>borrower app, ops portal, lender portal,<br/>API and worker"]

  borrower -->|"request, consent, compare, accept, repay, complain"| udofin
  lstaff -->|"products, decisions, offers"| udofin
  ops -->|"exception handling, read-only"| udofin
  admin -->|"onboard lenders, publish notices"| udofin
  auditor -->|"read records and audit trail"| udofin
  field -.->|"assisted onboarding"| udofin

  subgraph lenderSide["Lender systems of record"]
    lms["Lender LOS/LMS<br/>Finbyx or third-party"]
  end

  subgraph lenderRails["Rails used under each lender's credentials"]
    kyc["KYC: DigiLocker, CKYC, PAN,<br/>Aadhaar via lender's KUA, penny drop"]
    bureau["Credit bureaus"]
    aa["Account Aggregators"]
    esign["eSign ESP and eStamp"]
    pay["Payment aggregators, eNACH,<br/>UPI AutoPay, BBPS"]
  end

  subgraph comms["Messaging"]
    sms["SMS via DLT provider"]
    push["Push via Expo, FCM, APNs<br/>no personal data in payload"]
  end

  subgraph eco["Group ecosystem, separate products"]
    ldc["LawDocsComply<br/>compliance evidence"]
    equator["Equator<br/>optional dispute resolution"]
  end

  acct["Accounting exports<br/>Tally, SAP"]
  rbi["RBI Ombudsman portal<br/>link only"]

  udofin <-->|"REST and signed events"| lms
  udofin -->|"orchestrates in lender's name"| kyc
  udofin -->|"lender pulls, Udofin gets outcome"| bureau
  udofin --> aa
  udofin --> esign
  udofin -->|"instructions, webhooks"| pay
  udofin --> sms
  udofin --> push
  udofin -->|"IDs and metrics only"| ldc
  udofin -.->|"borrower-initiated consent token"| equator
  udofin -->|"exports"| acct
  udofin -.->|"shows route and deadline"| rbi
```

---

## 3. Containers

**Plain English.** The separately running pieces that make up Udofin. There is one backend codebase (a "modular monolith") that runs as two processes: the API, which answers requests, and the worker, which runs background jobs. All data stays in India.

| Container            | Technology                                                                                                                                  | Responsibility                                                                                                                                                                                                                                          | Status                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Borrower mobile app  | Expo SDK 57, React Native 0.86.3, expo-router (`apps/mobile`)                                                                               | Borrower journeys. Declares no runtime permissions and strips 28 prohibited Android permissions through `android.blockedPermissions` in `apps/mobile/app.config.ts`. OTA updates disabled. Bundle id `com.udofin.app` is a placeholder pending decision | Built: sign-in and the borrower journey through consent, lender choice, offers, KFS and acceptance, in English and Hindi (Phases 03 to 07). **Never run on a device.** Later journeys Planned                                                                                                     |
| Ops portal           | Next.js 16.4, React 19.2.3 (`apps/ops-portal`)                                                                                              | Udofin operations and platform administration                                                                                                                                                                                                           | Built: cookie-session sign-in with TOTP (ADR 0026), nonce CSP (`proxy.ts`), security headers, `noindex`; screens for lender onboarding, products and administration. No screens yet for KFS rules, templates or calendars (API only)                                                              |
| Lender portal        | Next.js 16.4, React 19.2.3 (`apps/lender-portal`)                                                                                           | Partner lender staff                                                                                                                                                                                                                                    | Built: same sign-in and controls; screens for onboarding, products, the lender panel, applications and KFS documents. The newer screens have no browser test yet                                                                                                                                  |
| API                  | Fastify 5 (`services/api`)                                                                                                                  | All reads and writes from the three clients; business rules; authorisation; integrations                                                                                                                                                                | Built: validated config, redacting logger, request ids, helmet, CORS allowlist, rate limits, RFC 9457 errors, token verification, per-request database context, idempotency, `/v1` routes with generated OpenAPI; image recipe `infra/docker/api.Dockerfile`. Not deployed                        |
| Worker               | Same codebase, separate entrypoint                                                                                                          | Outbox relay, retries, LMS sync, provider-webhook processing, routing, expiry, document generation, audit anchoring                                                                                                                                     | Built: outbox worker (`workers/main.ts`) with leases, retries and a dead state; handlers for change requests, routing and documents. A separate lender callback receiver verifies signed lender events. Not deployed; recovery is SQL ([runbook](../operations/runbook-outbox.md))                |
| Postgres             | Supabase project `Udofin-app`, ap-south-1 (Mumbai), Postgres 17.6 (confirmed in research)                                                   | Operational store; schema source of truth is `supabase/migrations/*.sql`                                                                                                                                                                                | Built: forward-only migrations (the directory is the count) with RLS, triggers and pgTAP tests. No hosted project was inspected                                                                                                                                                                   |
| Job queue and outbox | An outbox table and functions inside the same Postgres, run by our own worker. pg-boss was not adopted (ADR 0011, amendment of 13 Oct 2026) | Durable jobs enqueued in the same transaction as the business change. No Redis/BullMQ, no hosted Inngest/Trigger.dev, no Restate. Temporal (Mumbai/Hyderabad regions) only if multi-step flows become hard to manage                                    | Built (Phase 03). Delivery is at least once; ordering is not guaranteed                                                                                                                                                                                                                           |
| Object storage       | Amazon S3 ap-south-1 with SSE-KMS; per-lender data keys                                                                                     | KYC artefacts and loan documents; served only through short-lived presigned URLs after API authorisation. Supabase Storage is not used for these, because its CDN caches signed URLs at global edges                                                    | Port built; only a local development store exists (refused when deployed). The S3 + KMS store is not built, so deployed environments answer 503 on document routes. Reads stream through the API after a database authorisation call; see [spec](../operations/document-store-production-spec.md) |
| Authentication       | Supabase Auth (same Mumbai project)                                                                                                         | Phone OTP for borrowers; email plus MFA for staff, later SAML SSO; API verifies tokens against JWKS with `jose`                                                                                                                                         | Built: staff password + TOTP; borrower phone OTP through the signed Send-SMS hook. Real SMS delivery is not built (labelled mock only). The API verifies tokens against the JWKS with `jose`                                                                                                      |
| Observability        | OpenTelemetry to an India-hosted backend (CloudWatch or self-hosted Grafana stack in ap-south-1)                                            | Logs, traces, metrics; at least 180 days of logs in India (CERT-In [likely])                                                                                                                                                                            | Not built: structured logs to standard output only. Specification: [`observability-spec.md`](../operations/observability-spec.md). Sentry SaaS is avoided for personal data (stores data in the US/EU [confirmed])                                                                                |

```mermaid
flowchart TB
  subgraph clients["Clients"]
    mobile["Borrower mobile app<br/>Expo SDK 57<br/>Built, never run on a device"]
    opsportal["Ops portal<br/>Next.js 16.4<br/>Built"]
    lenderportal["Lender portal<br/>Next.js 16.4<br/>Built"]
  end

  auth["Supabase Auth<br/>phone OTP, staff email + MFA<br/>Built; real SMS not"]

  subgraph backend["Udofin backend, one codebase"]
    api["API<br/>Fastify 5 modular monolith<br/>Built"]
    worker["Worker<br/>outbox jobs, callbacks<br/>Built"]
  end

  subgraph stores["Data stores, India only"]
    pg[("Postgres<br/>Supabase ap-south-1<br/>Built: schema and RLS")]
    queue[("Outbox<br/>inside Postgres<br/>Built")]
    s3[("S3 ap-south-1 + KMS<br/>per-lender keys<br/>Not built")]
  end

  obs["OpenTelemetry to India-hosted backend<br/>Not built (spec only)"]
  ext["Lender systems and rails,<br/>messaging, ecosystem products"]

  mobile -->|"HTTPS /v1, bearer token"| api
  opsportal -->|"HTTPS /v1"| api
  lenderportal -->|"HTTPS /v1"| api
  mobile -->|"sign-in"| auth
  opsportal -->|"sign-in"| auth
  lenderportal -->|"sign-in"| auth
  api -->|"verify JWT via JWKS"| auth
  api -->|"user context: SET LOCAL ROLE authenticated"| pg
  api -->|"enqueue in same transaction"| queue
  worker -->|"system context: service_role"| pg
  worker --> queue
  api -->|"presigned URLs after authorisation"| s3
  worker --> s3
  worker <-->|"adapters, signed webhooks"| ext
  api -.-> obs
  worker -.-> obs
```

The clients never query domain tables directly. The domain schemas (`tenancy`, `identity`, `consent`, `audit`, `lending`, `servicing`, `payments`, `onboarding`, `documents`, `ops`) are not exposed through Supabase's REST layer (`supabase/config.toml` exposes only `public` and `graphql_public`), and `anon` has no rights on them (`supabase/migrations/20261010000100_foundation.sql`). Every client call goes through the API.

---

## 4. Deployment topology

**Plain English.** Three environments. Only production may ever hold real borrower or lender data, and production runs only in India. The staging environment runs on Railway, which has no India region, so it must only ever hold made-up (synthetic) data.

|                         | Local                                                                                                                                                   | Staging (and any dev/preview)                                                                                                                                                                                                                                       | Production                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose                 | Development and tests                                                                                                                                   | Integration testing, demos, lender UAT with synthetic data                                                                                                                                                                                                          | Real borrowers and lenders                                                                                                                            |
| Data                    | Synthetic only                                                                                                                                          | **Synthetic only.** Never copy production data down                                                                                                                                                                                                                 | Real data, India-only                                                                                                                                 |
| Compute                 | Developer machine: `tsx` for the API, Next.js dev servers, Expo development build                                                                       | Railway (regions: US West, US East, EU West Amsterdam, Southeast Asia Singapore; no India region, no bring-your-own-cloud [confirmed])                                                                                                                              | AWS ap-south-1 (Mumbai), ECS on Fargate (App Runner closed to new customers from 30 Apr 2026 [confirmed]) behind a regional load balancer with WAF    |
| Database and auth       | Plain PostgreSQL 16 with a local-only Supabase shim (`scripts/db/local-supabase-shim.sql`, run by `scripts/db-test-local.sh`) or the Supabase CLI stack | A separate Supabase project (region to be decided; ap-south-1 recommended so behaviour matches production)                                                                                                                                                          | Supabase project in ap-south-1 (Mumbai). Written confirmation from Supabase of where backups and platform logs live is still outstanding [unverified] |
| Files                   | Local disk or local stack                                                                                                                               | No real documents                                                                                                                                                                                                                                                   | S3 ap-south-1, SSE-KMS, Block Public Access, Object Lock for audit/log archives                                                                       |
| Logs                    | Console                                                                                                                                                 | Railway retains logs and traces (Pro plan: 30 days [confirmed]) in a location it does not document; assume outside India [unverified]. Logs must never contain personal data; the API's logger already redacts known fields                                         | OpenTelemetry collector in ap-south-1, India-hosted backend, at least 180 days in India                                                               |
| Secrets                 | `.env` files from `.env.example`                                                                                                                        | Railway sealed variables                                                                                                                                                                                                                                            | AWS Secrets Manager (ap-south-1)                                                                                                                      |
| Deployment artefact     | n/a                                                                                                                                                     | Container images built from Dockerfiles: the API image exists (`infra/docker/api.Dockerfile`, multi-stage, non-root, built in CI); no portal or worker image has been built. No `railway.json`/`railway.toml`: Railway stops reading them on 2026-12-01 [confirmed] | Same images, deployed to ECS; infrastructure as code with OpenTofu or Terraform                                                                       |
| `APP_ENV` value in code | `local` (`test` in unit tests)                                                                                                                          | `staging`                                                                                                                                                                                                                                                           | `production`                                                                                                                                          |
| Status                  | Built (local DB tests; API, portals and app run locally)                                                                                                | Not built. Nothing is deployed ([`../operations/deployment.md`](../operations/deployment.md))                                                                                                                                                                       | Not built. In full use **before the first real borrower or lender data** (Phase 11 at the latest)                                                     |

Additional production rules:

- Disaster recovery to AWS ap-south-2 (Hyderabad) later. Supabase offers only ap-south-1 in India [likely], so in-country database DR on Supabase is not available.
- If Supabase Edge Functions are ever used, pin them to ap-south-1; by default they run in the region nearest the caller [confirmed].
- Supabase read replicas, if added, only in ap-south-1.
- The mobile app is built with EAS Build and distributed through the stores. Push notifications pass through Expo, FCM and APNs outside India, so payloads carry no personal data.

```mermaid
flowchart TB
  subgraph localEnv["Local: developer machine, synthetic data"]
    lapp["Expo dev build, Next.js dev servers"]
    lapi["API via tsx"]
    ldb[("PostgreSQL 16 + local Supabase shim<br/>or Supabase CLI stack")]
    lapp --> lapi --> ldb
  end

  subgraph stagingEnv["Staging: Railway, SYNTHETIC DATA ONLY"]
    sapi["API and worker containers<br/>API image built in CI; worker and portal images not built"]
    sportals["Portal containers"]
    sdb[("Separate Supabase project<br/>region to decide")]
    sportals --> sapi --> sdb
  end

  subgraph prodEnv["Production: India only"]
    subgraph awsMum["AWS ap-south-1 Mumbai"]
      alb["Load balancer + WAF"]
      ecs["ECS on Fargate<br/>API, worker, portals"]
      s3p[("S3 + KMS<br/>per-lender keys")]
      otel["OTel collector, log and trace store<br/>180 days or more"]
      secrets["Secrets Manager"]
      alb --> ecs
      ecs --> s3p
      ecs -.-> otel
      ecs --> secrets
    end
    subgraph supaMum["Supabase ap-south-1 Mumbai"]
      ppg[("Postgres 17")]
      pauth["Auth"]
    end
    ecs --> ppg
    ecs --> pauth
    dr["DR: AWS ap-south-2 Hyderabad<br/>later"]
    s3p -.-> dr
  end

  stores(["App stores via EAS Build"])
  stores -.->|"borrower devices call"| alb
```

---

## 5. Modules (bounded contexts)

**Plain English.** Inside the single backend, the code is split into modules with clear owners, like departments. Each module owns its own tables; other modules ask it, they do not reach into its tables. This keeps one deployable system (simple to run) while keeping the boundaries we would need if a module ever had to be split out.

Rules:

- One deployable API plus one worker entrypoint from the same codebase. Not microservices.
- A module writes only its own tables. Other modules use its interface or its events.
- Shared code: `packages/domain` (money in paise as `bigint`, declarative state machines, the application lifecycle in `packages/domain/src/lifecycles/application.ts`) and `packages/contracts` (event envelope, problem details, money wire format). Provider interfaces ("ports"), labelled mocks, the environment guard, the PDF renderer and the document store are in `packages/adapters`; no real provider adapter exists.
- A Postgres schema can hold more than one module's tables (for example `lending` holds products, applications and offers), but each table has exactly one owning module.
- Module-boundary lint rules: built. A module may not import a sibling, and only `src/system` and `src/workers` may import the system database pool (root `eslint.config.mjs`, `services/api/test/boundary.test.ts`).

| Module                   | Responsibility                                                                                                               | Owned tables (existing)                                                                                                                        | Status                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity                 | Borrower accounts: link to the sign-in identity, status, language. Minimal data only                                         | `identity.borrowers`. The phone number stays in Supabase Auth (`auth.users`)                                                                   | Built: table, signup trigger, profile, step-up and integrity records, deletion that anonymises (ADR 0029). Real SMS and removal of the phone identity are pending       |
| tenancy                  | Organisations (one platform org, lenders, service partners), memberships, roles, permissions                                 | `tenancy.organizations`, `tenancy.permissions`, `tenancy.roles`, `tenancy.role_permissions`, `tenancy.memberships`, `tenancy.membership_roles` | Built: guards, RLS helpers, two-person change requests (ADR 0025) and the lender onboarding workflow (ADR 0028)                                                         |
| consent                  | Versioned notices with SHA-256 of the exact wording; append-only consent ledger                                              | `consent.notices`, `consent.records`, view `consent.current_decisions`                                                                         | Built: capture and withdrawal (ADR 0029, 0030). No approved wording for any lender yet (D-37, D-42)                                                                     |
| audit                    | Tamper-evident record of who did what                                                                                        | `audit.events`, `audit.anchors`                                                                                                                | Built: per-row hash, actor derived from the session, tamper detection even by a superuser. Anchoring job and export to write-once storage: not built (ADR 0013)         |
| lender-config / products | Platform product categories; lender products and immutable, maker-checker-approved versions; later lender settings           | `lending.product_categories`, `lending.loan_products`, `lending.loan_product_versions`                                                         | Built: lender profile, gated onboarding, products with maker-checker and portal screens (ADR 0028)                                                                      |
| applications             | The borrower's loan request; one application per lender; lifecycle with actor rules and event history                        | `lending.loan_requests`, `lending.applications`, `lending.application_transitions`, `lending.application_events`                               | Built: loan request API and app screens (Phase 05); routing to lenders (Phase 06)                                                                                       |
| verification             | KYC orchestration under the lender's credentials; results only in lender-scoped encrypted storage                            | none yet                                                                                                                                       | Planned (Phase 6)                                                                                                                                                       |
| decisioning-integration  | Sends applications to each lender's decision system or portal queue; records the lender's decision and rule version          | `lending.application_routing`, `lending.lender_decisions`, `lending.inbound_messages`, `lending.lender_connectors`                             | Built (Phase 06): consented routing, lender-reported status by portal entry or signed callbacks. No real lender connector (D-43)                                        |
| offers                   | Offers with frozen terms; comparison display; acceptance; display log                                                        | `lending.offers`, `lending.offer_intake`, `lending.comparison_runs`, `lending.offer_displays`, `lending.comparison_nonoffers`                  | Built: offer intake, comparison and display log (ADR 0030); acceptance (Phase 07). Ordering rule awaits approval (D-16)                                                 |
| documents                | KFS, sanction letter and agreement from lender templates; eSign and eStamp orchestration; hashes                             | `documents.items`, `templates`, `applicability_rules`, `calendars`, `acknowledgements`, `acceptances`, `signing_*`, `deliveries`, `access_log` | Built (Phase 07, ADR 0031): KFS, hashed immutable documents, acceptance. Signing is a labelled mock; local store only                                                   |
| servicing-sync           | Read-model of the lender's LMS: loan account, disbursement evidence, schedules                                               | `servicing.loan_accounts`, `servicing.schedule_snapshots`, `servicing.schedule_installments`                                                   | Built: schema. Planned (Phase 7) first sync at disbursement; (Phase 8) ongoing sync                                                                                     |
| payments                 | Payment instructions under the lender's credentials; provider events; reconciliation                                         | `payments.payment_intents`, `payments.provider_events`                                                                                         | Built: schema. Planned (Phase 8)                                                                                                                                        |
| mandates                 | eNACH and UPI AutoPay mandates in the lender's name                                                                          | none yet                                                                                                                                       | Planned (Phase 8)                                                                                                                                                       |
| collections              | Reminders; recovery-agent workflows only if the lender appoints Udofin as its recovery agent                                 | none yet                                                                                                                                       | Planned (Phase 8)                                                                                                                                                       |
| grievance                | Complaint tickets, routing to the lender's grievance officer, 30-day clock, Ombudsman information, optional Equator referral | none yet                                                                                                                                       | Planned (Phase 9)                                                                                                                                                       |
| notifications            | SMS (DLT), push, email; transactional and marketing kept separate                                                            | none yet                                                                                                                                       | Ports and labelled mocks only (SMS sender, delivery notices); no provider contracted                                                                                    |
| integrations             | Provider adapters (LMS, KYC, bureau, AA, eSign, payments); outbox; signed webhooks; ecosystem events; accounting exports     | `packages/adapters`, `packages/contracts`, `ops.outbox_events`                                                                                 | Built: event envelope, outbox and worker, ports with labelled mocks. No real provider. Planned: (Phase 8) LMS and payment adapters; (Phase 10) ecosystem and accounting |
| reporting                | Lender MIS, reports lenders need for their own regulatory work, Udofin's own finance views                                   | none yet                                                                                                                                       | Planned (Phase 10)                                                                                                                                                      |

Two gaps in the module list, to resolve when Phase 10 is specified: Udofin's own double-entry books (LSP fees receivable, DLG exposure, collection fees) have no named module, and AI support (Phase 9) is a capability used by grievance and notifications, not a module that decides anything.

---

## 6. Request path

**Plain English.** When a signed-in person uses the app or a portal, the API first checks who they are and whether they may do the action. It then talks to the database **as that person**, so the database applies its own row-level rules as a second, independent check. If the API had a bug that forgot a permission check, the database would still refuse to show or change another lender's or another borrower's data.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client (app or portal)
  participant A as Udofin API
  participant K as Supabase Auth JWKS
  participant D as Postgres
  C->>A: HTTPS request with bearer access token
  A->>A: Request id, rate limit, CORS, security headers [Built]
  A->>K: Fetch signing keys, cached [Built]
  A->>A: Verify JWT with jose, validate input with zod, route permission check [Built]
  A->>D: BEGIN, SET LOCAL ROLE authenticated, set_config request.jwt.claims transaction-local [Built]
  A->>D: Calls to Postgres functions through pg with bound parameters (Kysely was not adopted) [Built]
  D->>D: RLS policies filter rows, triggers enforce lifecycle and immutability [Built]
  A->>D: Audit event and outbox row in the same transaction [Built]
  A->>D: COMMIT
  A-->>C: JSON, or RFC 9457 problem+json, with x-request-id [error format Built]
```

How the database side works (Built, and exercised by the pgTAP tests, which switch users exactly this way):

- `SET LOCAL ROLE authenticated` and `set_config('request.jwt.claims', <claims>, true)` last only until the end of the transaction, so a pooled connection cannot leak one user's identity into the next request.
- RLS policies identify the caller only through `auth.uid()` (the token's `sub`). They do **not** trust role or tenant claims in the token. Permissions are looked up in `tenancy` at query time through `private.my_org_ids()`, `private.orgs_with_permission(p)` and `private.has_platform_permission(p)`. A suspended or expired membership therefore loses access immediately, without waiting for the token to expire (tested).
- These helpers return sets of organisation ids, so a policy written as `lender_org_id in (select ...)` is evaluated once per statement, not once per row.
- Column-level grants stop users rewriting tenant keys, borrower ids or amounts even where a row is visible.
- Errors never leak internals: 5xx responses carry only a generic title, a code and the request id (`services/api/src/app.ts`).

Current state: the per-request transaction helper, JWT verification, the `/v1` routes, the API's restricted login role and the `Idempotency-Key` requirement on state-changing POSTs (ADR 0027) are built. Kysely was not adopted (ADR 0004, amendment of 14 Oct 2026); business rules live in SQL functions (ADR 0033). The database also rejects a duplicate payment idempotency key per lender.

---

## 7. Two database access modes

**Plain English.** The database is used in two ways. Most of the time the API acts **on behalf of a person**, and the database limits what that person can see and do. A few trusted background jobs act **as the system**, for example recording that a payment provider confirmed a payment. System mode is powerful, so it is kept out of the code that handles user requests.

|                                      | User context                                                                                                               | System context                                                                                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Used by                              | The API, while serving a signed-in borrower or staff member                                                                | Worker code paths only: LMS sync, verified provider webhooks, routing a consented request to lenders, expiry jobs, audit anchoring                                                                                                             |
| Postgres role inside the transaction | `authenticated` (via `SET LOCAL ROLE`)                                                                                     | `service_role`                                                                                                                                                                                                                                 |
| `auth.uid()`                         | The caller's user id, from verified JWT claims                                                                             | `NULL`                                                                                                                                                                                                                                         |
| Row Level Security                   | Applies (forced on data tables)                                                                                            | Bypassed (`service_role` has `BYPASSRLS` in Supabase; the local shim mirrors this)                                                                                                                                                             |
| Triggers and constraints             | Always apply. The acting party is recorded as `borrower`, or as `lender` for any signed-in non-borrower                    | Always apply. The acting party is recorded as `system`                                                                                                                                                                                         |
| What only this mode can do           | Borrower: accept an offer; submit or withdraw own request. Lender staff with `application.decide`: decide and issue offers | Create applications; mark a payment intent succeeded or failed; move an application to `agreement_pending`, `agreement_executed` or `disbursed` (the last only with disbursement evidence); write the servicing read-model and provider events |
| Audit                                | `private.record_audit_event()` derives the actor from the session, so it cannot be forged (tested)                         | Writes audit events directly with actor type `system` (no helper: `record_audit_event` refuses system context by design)                                                                                                                       |
| Status                               | Built in the database and in the API                                                                                       | Built in the database and in the worker and callback receiver                                                                                                                                                                                  |

Guardrails:

- `service_role` credentials are given only to the worker process. The API's login (`udofin_api`) can assume `authenticated` and nothing more; the worker's login (`udofin_system`) can assume only `service_role` (`supabase/migrations/20261013000720_api_login_roles.sql`). The API refuses to start if its login could skip row-level security (`services/api/src/db/login-posture.ts`).
- Even in system context, the database refuses to break its own rules: append-only tables cannot be edited, offer and payment amounts cannot change, an application cannot be marked disbursed without evidence, and an approved product version cannot change.
- Platform staff reach lender data only through permissions marked `platform_grantable` (`org.members.read`, `product.read`, `application.read`, `loan.read`, `payment.read`, `audit.read`). Each such access is to be audited by the API; whether that is built was not verified on 14 October 2026.

Open item, partly resolved: the comment in `supabase/migrations/20261010000200_tenancy_and_access.sql` says tenancy writes happen "through the API under service_role". Organisation, membership and role changes now go through two-person change requests applied by the worker (ADR 0025), and lender onboarding writes are function-only (ADR 0028). For consent notices, no database function or API route for publishing wording was found by name in the migrations on 14 October 2026; the write path still has to be decided together with the wording approval (D-37).

---

## 8. Principles: system of record and money flow

### 8.1 System of record

**Plain English.** For every piece of information there is one place that is "the truth". For loans, that place is the lender's LMS, not Udofin.

| Information                                                                               | System of record                                                                | What Udofin keeps                                                                                                                                                   | Status                                                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Loan balance, schedule, receipt allocation, accrual, provisioning, NPA status, accounting | Lender's LMS (Finbyx or third-party)                                            | Immutable snapshots as received (`servicing.*`), versioned; never edited, never recalculated as a competing ledger                                                  | Built (schema)                                                            |
| Credit decision                                                                           | Lender                                                                          | The outcome, offer terms and the lender's reference (`lending.applications.lender_reference`)                                                                       | Built (schema)                                                            |
| KYC results, bureau reports, AA data                                                      | Lender                                                                          | Nothing in the core schema. Where the lender instructs Udofin to hold artefacts as its processor, they go to lender-scoped storage encrypted with that lender's key | Planned (Phase 6)                                                         |
| KFS, sanction letter, loan agreement, eSign and eStamp evidence                           | Lender                                                                          | Document hashes and references; files in lender-scoped encrypted storage                                                                                            | Built (Phase 07): hashed, immutable documents; signing is a mock          |
| Borrower account                                                                          | Udofin                                                                          | Minimal data (`identity.borrowers`)                                                                                                                                 | Built                                                                     |
| Consents Udofin collects                                                                  | Udofin                                                                          | Append-only ledger                                                                                                                                                  | Built                                                                     |
| Complaint                                                                                 | Lender (authoritative) with a linked Udofin ticket                              | The Udofin ticket                                                                                                                                                   | Planned (Phase 9)                                                         |
| Udofin's own fees, DLG exposure, collection fees                                          | Udofin's double-entry books. Tally and SAP are export destinations, not ledgers | Udofin's books                                                                                                                                                      | Planned (Phase 8 DLG ledger, only if Udofin provides DLG; Phase 10 books) |

### 8.2 Money flow

**Plain English.** Money never passes through Udofin.

- No Udofin pool or pass-through account. Every payment intent names the lender's collection account it settles into (`payments.payment_intents.settlement_account_ref`); the schema has no concept of a Udofin collection account. (Built)
- Disbursement goes from the lender's account to the borrower's verified bank account. Research reports three exceptions: disbursals required by statute or regulation, money moving between lenders in co-lending, and specific end-use loans paid directly to the end-beneficiary (for example a dealer or hospital) [confirmed (secondary)]. (Planned, Phase 7)
- Repayments settle directly into the lender's account, using the lender's own merchant and mandate credentials: Razorpay, Cashfree, PayU or Juspay; eNACH or UPI AutoPay; BBPS or virtual accounts. (Planned, Phase 8)
- Stripe (invite-only in India since 2024) and PayPal (no domestic India payments since 2021) are excluded for domestic repayments. They may be used only for Udofin's own cross-border B2B billing, if ever needed.
- Udofin's own gateway account is used only for Udofin's B2B fees. The lender pays Udofin; the borrower is never charged by Udofin [confirmed (secondary)].
- Approval never moves money and never makes an application "disbursed". The database allows `disbursed` only when the lender's disbursement evidence (date, amount and bank reference, all three) is recorded (Built, tested).

---

## 9. End-to-end loan journey

**Plain English.** The full path from a borrower's request to repayment and reconciliation, across several lenders. Notes on the right show what the database already enforces and what is still to be built.

```mermaid
sequenceDiagram
  autonumber
  actor B as Borrower app
  participant U as Udofin API and worker
  participant LA as Lender A LOS/LMS
  participant LB as Lender B LOS/LMS
  participant R as Rails in lender's name<br/>bureau, KYC, eSign, eStamp
  participant P as Payment rail<br/>lender's merchant ID

  B->>U: Create loan request (amount, tenure, purpose)
  Note right of U: [Built] loan_requests, editable only in draft<br/>[Built, Phase 05] API and screens
  B->>U: Consent to share with each named lender
  Note right of U: [Built] append-only consent ledger, capture<br/>[Open] approved notice wording (D-37)
  U->>LA: Route request as Lender A application
  U->>LB: Route request as Lender B application
  Note right of U: [Built] one application per lender, consented routing<br/>[Open] real lender connector (D-43)
  LA->>R: Bureau pull under Lender A's membership
  LB->>R: Bureau pull under Lender B's membership
  LA-->>U: Decision and offer
  LB-->>U: Decision or rejection
  Note right of U: [Built] lender-only decisions, frozen offer terms,<br/>lender-reported status by portal or signed callback
  U->>B: All matching offers, non-matching lenders named, KFS links
  Note right of U: [Built, Phase 06] every display logged<br/>[Open] approved neutral ordering rule (D-16)
  B->>U: Accept Lender A's offer
  Note right of U: [Built] borrower only, unexpired,<br/>one lender per request past acceptance
  U->>R: KYC, KFS, eSign and eStamp in Lender A's name
  Note right of U: [Planned] KYC under selected lender<br/>[Built, Phase 07] KFS, documents; signing is a mock
  LA->>B: Disburse from Lender A's account to borrower's verified account
  LA-->>U: Disbursement evidence and repayment schedule
  Note right of U: [Built] disbursed only with evidence, immutable snapshots<br/>[Planned P7] first LMS sync
  B->>P: Repay via link, eNACH or UPI AutoPay
  P->>LA: Settles to Lender A's account
  P-->>U: Signed webhook, status only
  LA-->>U: Receipt allocation, updated balance and schedule
  Note right of U: [Built] payment intents, webhook de-duplication<br/>[Planned P8] adapters, mandates, ongoing sync
  U->>U: Reconcile intents, provider events and LMS data
  Note right of U: [Planned P8] exceptions to ops<br/>[Planned P10] finance reporting
```

| #   | Step                                    | Acts                                          | Built (database unless stated; checked 14 Oct 2026)                                                                                                                                                                                                                       | Still to build                                                                                                                                                                     |
| --- | --------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sign-up                                 | Borrower, Supabase Auth                       | Trigger creates `identity.borrowers` for every new non-staff user; phone OTP through Supabase Auth and the signed Send-SMS hook; minimal profile (Phase 05)                                                                                                               | A real DLT-registered SMS provider (only a labelled mock exists); a run on a device                                                                                                |
| 2   | Loan request                            | Borrower                                      | `lending.loan_requests`: terms editable only in `draft`, expiry, purpose, required consents and product availability enforced by the database; API and app screens (Phase 05)                                                                                             | Owner-approved purpose list and consent wording (open decisions)                                                                                                                   |
| 3   | Consent                                 | Borrower                                      | `consent.records` append-only, only against a published notice with hashed immutable wording; separate consent per lender; withdrawal is a new row (Phases 05 and 06)                                                                                                     | Approved notice wording, general and per lender (D-37, D-42); without it sharing with a lender is blocked by design                                                                |
| 4   | Routing to N lenders                    | System                                        | One application per lender per request; composite keys; consent revalidated in the database when a job sends; up to five lenders; uncertain sends reconciled by lookup (Phase 06)                                                                                         | A real lender connector and callback scheme (D-43); until then a lender uses the portal or a labelled mock                                                                         |
| 5   | Lender decisions                        | Lender staff or the lender's system           | Lender-reported status (acknowledgement, checks, decision, offer, withdrawal) by portal entry or signed callback through the same private functions; offer terms frozen once issued; one live offer per application                                                       | Real lender systems; bureau, KYC and AA run under the lender's own credentials and are not built by Udofin                                                                         |
| 6   | Offer comparison                        | Borrower sees                                 | Offers stored as supplied; `lending.compare_offers` records every run, every offer shown with its rank and rule version, and every named lender that did not offer. It refuses to order until a rule is approved by two people (ADR 0030)                                 | An approved ordering rule (D-16) and user testing; rule reported in research as RBI DL Directions para 6, effective 1 Nov 2025 [confirmed (secondary); paragraph number to verify] |
| 7   | Acceptance                              | Borrower                                      | Only the borrower can accept; expired offers cannot be accepted; acceptance consumes a step-up bound to the offer in one transaction; a revised offer needs a new acknowledgement (ADR 0031)                                                                              | Closing the other applications and marking the request `offer_selected`: not re-checked on 14 Oct 2026                                                                             |
| 8   | KYC, KFS, eSign/eStamp under the lender | Borrower with the lender; Udofin orchestrates | KFS (generated from lender data or uploaded), validity window, working-day calendar, hashed immutable documents, acknowledgement; signing is a labelled mock with no legal effect; `agreement_pending` and `agreement_executed` stay system-only (Phase 07)               | KYC under the selected lender; a real eSign and eStamp provider (D-13, D-58); the S3 document store                                                                                |
| 9   | Disbursement by the lender              | Lender                                        | `disbursed` only with date, amount and bank reference recorded; disbursed amount cannot exceed sanctioned amount                                                                                                                                                          | LMS callback or sync that records the evidence (Phase 7)                                                                                                                           |
| 10  | LMS sync                                | System                                        | Schedule snapshots and instalments are append-only and versioned                                                                                                                                                                                                          | Ongoing sync (Phase 8)                                                                                                                                                             |
| 11  | Repayment to the lender's account       | Borrower pays; lender receives                | Payment intents: idempotency key unique per lender; amounts and parties immutable; only the system marks `succeeded` or `failed`; borrower can cancel only a `created` intent; provider events de-duplicated on provider and event id, raw payload not stored (hash only) | Provider adapters, mandates, signature verification, cooling-off exit payments (Phase 8)                                                                                           |
| 12  | Reconciliation                          | System, ops                                   | —                                                                                                                                                                                                                                                                         | Matching intents, provider events and LMS receipts; exceptions to ops; the LMS stays authoritative (Phase 8); finance reporting (Phase 10)                                         |

---

## 10. Cross-cutting controls already in code

| Control                                                                                                                                                                                                                  | Where                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Configuration validated at start-up; deployed environments require `DATABASE_URL` and `SUPABASE_URL`; no wildcard or plain-http CORS origins when deployed; no `trace` logging in production                             | `services/api/src/config.ts`                                                                   |
| Logger redacts credentials, OTPs, PAN, Aadhaar, CKYC number, phone, email, date of birth, account numbers, UPI ids, addresses and names                                                                                  | `services/api/src/logger.ts`                                                                   |
| Caller-supplied request ids accepted only if well-formed (prevents log injection); `cache-control: no-store` on every API response                                                                                       | `services/api/src/app.ts`                                                                      |
| Readiness checks with a timeout that report dependency names only, never errors                                                                                                                                          | `services/api/src/app.ts`, `services/api/src/server.ts`                                        |
| Per-request nonce Content-Security-Policy, no framing, no third-party origins; HSTS, `nosniff`, `no-referrer`, restrictive Permissions-Policy                                                                            | `apps/*/proxy.ts`, `apps/*/next.config.ts`                                                     |
| Money as integer paise (`bigint`), exact parsing, loss-free allocation; on the wire as an integer string                                                                                                                 | `packages/domain/src/money.ts`, `packages/contracts/src/primitives.ts`                         |
| Event envelope based on CloudEvents 1.0 with `tenantid`, `correlationid`, `causationid`, `dataclassification`; event types `in.<product>.<aggregate>.<fact>.v<major>` for `udofin`, `finbyx`, `lawdocscomply`, `equator` | `packages/contracts/src/events/envelope.ts`                                                    |
| Application lifecycle defined once in TypeScript and once in SQL, with a test that fails if they diverge                                                                                                                 | `packages/domain/src/lifecycles/application.ts`, `packages/domain/test/lifecycle-sync.test.ts` |
| Tenant branding limited to primary, on-primary and accent colours, with contrast checks; status colours locked                                                                                                           | `packages/design-tokens`                                                                       |

---

## 11. Open items that affect this architecture

| Item                                                                                                                                                                                                                                                                                                                                                                                                     | Needed by                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| AWS account and owner for production in ap-south-1, in place before the first real borrower                                                                                                                                                                                                                                                                                                              | Before any real data (Phase 11 at the latest) |
| Supabase written confirmation of backup, PITR and platform-log residency                                                                                                                                                                                                                                                                                                                                 | Phase 2                                       |
| API and worker login roles (API can assume only `authenticated`; worker gets `service_role`) **Done** (migration `20261013000720_api_login_roles.sql`); passwords and the managed-project grants are still set by hand ([`../operations/supabase-setup.md`](../operations/supabase-setup.md))                                                                                                            | Phase 2                                       |
| Write path for tenancy administration and consent-notice publishing (see section 7) Tenancy: done (change requests, ADR 0025). Consent-notice publishing: still open                                                                                                                                                                                                                                     | Phase 2/3                                     |
| CI exists (`.github/workflows/ci.yml`: format, build, lint, typecheck, unit tests, Expo config check, audit-ignore scope check, production dependency audit; pgTAP and API integration tests on the Supabase CLI with Postgres 17; browser tests of the portals; gitleaks secret scan; API image build). Not re-checked on 14 Oct 2026: a check of the merged AndroidManifest for prohibited permissions | Phase 3                                       |
| Container images for the portals and the worker (only the API has one: `infra/docker/api.Dockerfile`)                                                                                                                                                                                                                                                                                                    | Phase 3                                       |
| Staging Supabase region                                                                                                                                                                                                                                                                                                                                                                                  | Phase 3                                       |
| Whether Udofin provides DLG and/or acts as a lender's recovery agent (changes collections and finance scope)                                                                                                                                                                                                                                                                                             | Phase 8                                       |
| Primary-source legal review of every regulatory reference                                                                                                                                                                                                                                                                                                                                                | Release gate                                  |

---

## Related documents

- [`ecosystem.md`](ecosystem.md): how Udofin relates to Finbyx, LawDocsComply and Equator.
- [`../data/ownership.md`](../data/ownership.md): ownership, classification, retention and storage rules per table.
- [`../data/entity-model.md`](../data/entity-model.md), [`../api/README.md`](../api/README.md), [`../operations/deployment.md`](../operations/deployment.md), [`../security/threat-model.md`](../security/threat-model.md), [`../product/open-decisions.md`](../product/open-decisions.md).
- Research behind this document: `docs/research/2026-10-10/infra-stack.md`, `docs/research/2026-10-10/rbi-digital-lending.md`, `docs/research/2026-10-10/providers-payments.md`, `docs/research/2026-10-10/kyc-aadhaar-bureau.md`.
