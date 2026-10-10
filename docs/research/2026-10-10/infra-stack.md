# Infrastructure, data residency and technology-stack choices for Udofin (as of 2026-10-10)

**Executive summary.** Udofin's database choice is sound: Supabase project `Udofin-app` runs in AWS ap-south-1 (Mumbai) on Postgres 17.6. Two other parts of the plan create residency problems that a lender's due diligence will find. First, **Railway has no India region.** It offers four deployment regions: US West (California), US East (Virginia), EU West (Amsterdam) and Southeast Asia (Singapore). It does not offer bring-your-own-cloud, so the Node API, workers, volumes, buckets and Railway-retained logs would all sit outside India. Second, **the sister product Finbyx runs in a Supabase project in ap-northeast-1 (Tokyo)**. This session confirmed that through the Supabase Management API. Finbyx is an LOS/LMS for Indian REs, so this is a direct conflict with RBI's digital-lending data-storage requirement and with lenders' outsourcing expectations, and it has to move before any real data goes in. My recommendation is to keep Supabase in Mumbai as the system of record. Use Railway only for non-production or for a short PII-free bridge. Move production compute to AWS ap-south-1 (ECS Fargate or ECS Express Mode) before the first real borrower or first RE goes live, rather than "later". Stay Postgres-centric for durable jobs: an outbox plus pg-boss now, and Temporal Cloud (which has Mumbai and Hyderabad regions) only if the sagas outgrow it. Keep Fastify 5, Kysely with RLS context per transaction, and **TypeScript pinned to 6.0.x**, because typescript-eslint does not support TS 7 and the TS 7 API is "not ready". Supabase-specific traps found:

- The Smart CDN caches signed-URL responses at global edges, even after the token expires.
- Edge Functions run in the region nearest the caller.
- Read replicas can be placed in foreign regions.
- Sentry SaaS stores data only in the US or EU.

## Research method and limitations

- The shared WebSearch budget ran out after a few searches, and the egress proxy blocked most non-GitHub hosts, including rbi.org.in, cert-in.org.in, supabase.com, railway.com and law-firm sites. Evidence therefore comes from:
  - vendor documentation read through official MCP connectors (Railway docs, Supabase docs, AWS Knowledge);
  - GitHub-hosted documentation (typescript-go, Sentry docs, Temporal docs, Fineract, pg-boss, typescript-eslint);
  - the npm registry;
  - one live Supabase Management API call (list projects).
- RBI and CERT-In wording could not be read from primary sources in this session. Claims about them are marked **[likely]**, and the regulatory research agents should confirm them.

## Findings

### 1. Railway: capabilities and residency

- **Regions.** Railway's regions page lists exactly four: `us-west2` (California), `us-east4-eqdc4a` (Virginia), `europe-west4-drams3a` (Amsterdam) and `asia-southeast1-eqsg3a` (Singapore). It says only that "additional regions may be added in the future". **[confirmed]** [Railway Docs – Regions](https://docs.railway.com/deployments/regions) (accessed 2026-10-10); [Railway Docs – Edge Networking](https://docs.railway.com/networking/edge-networking) (accessed 2026-10-10).
  - There is a user feature request for an India region, and it names Singapore as the closest region. **[confirmed as a request only; no launch]** [Railway Central Station – Add India Region](https://station.railway.com/feedback/add-india-region-for-deployment-25dee5be) (secondary, via search snippet).
- **No BYOC.** "Railway doesn't offer a bring-your-own-cloud option; all services run on Railway-owned infrastructure." **[confirmed]** [Railway vs Northflank FAQ](https://docs.railway.com/platform/compare-to-northflank#does-railway-support-byoc).
- **Where state would live on Railway.**
  - Volumes follow the service's region. **[confirmed]**
  - Storage buckets can be created only in `sjc`, `iad`, `ams` or `sin`, and a bucket's region cannot be changed. **[confirmed]** [railway bucket CLI](https://docs.railway.com/cli/bucket#create-a-bucket).
  - Railway-managed Postgres, including HA (Patroni, etcd, HAProxy), and Redis run as services in those same regions. **[confirmed]** [PostgreSQL HA](https://docs.railway.com/databases/postgresql-ha).
- **Logs.** Railway captures stdout and stderr, HTTP logs (including `@srcIp`, the client IP) and DNS logs. Retention by plan: Free 3 days, Hobby 7, **Pro 30**, Enterprise up to 90. "Railway does not have a log drain setting"; you forward logs with Vector or Fluent Bit, or emit them through OTel. There is also a rate limit of 500 lines per second per replica. Native traces are retained for the same period as logs. **[confirmed]** [Railway Docs – Logs](https://docs.railway.com/observability/logs#log-retention); [Tracing retention](https://docs.railway.com/observability/tracing#retention-and-limits).
  - The physical location of Railway's log and trace store is not documented. **[unverified; assume outside India]**
- **Features relevant to Udofin.** **[confirmed]**
  - Private networking: `<service>.railway.internal`, isolated per environment ([Private networking](https://docs.railway.com/networking/private-networking)).
  - Replicas, including multi-region replicas.
  - Cron jobs: minimum interval 5 minutes, evaluated in UTC, and a run is skipped if the previous one is still running ([Cron guide](https://docs.railway.com/guides/cron-workers-queues#cron-jobs)).
  - Builds: Dockerfile builds, or Railpack, which is the default builder.
  - Static outbound IPs, Pro plan and above ([Outbound networking](https://docs.railway.com/networking/outbound-networking)). These would be **Singapore** IPs, which matters for partners that allowlist Indian source IPs. **[interpretation]**
  - Opt-in outbound IPv6.
  - Compliance: **SOC 2 Type II and SOC 3**, plus a HIPAA BAA add-on, a DPA, and a trust center at trust.railway.com ([Compliance](https://docs.railway.com/enterprise/compliance)).
- **Config-as-code change.** `railway.json` / `railway.toml` are **deprecated**. New services cannot opt in, and existing files **stop being read on 2026-12-01 (hard cutoff)**. The replacement is project-level IaC in `.railway/railway.ts` (`npm install railway`), using `railway config plan|apply` and a GitHub Action, `railwayapp/config`. **[confirmed]** [Railway Docs – Infrastructure as Code](https://docs.railway.com/infrastructure-as-code).
  - The repo has no `railway.json` and its `infra/` directory is empty. Any Railway configuration written now should therefore go into `.railway/railway.ts`. **[confirmed by repo inspection]**

### 2. Is Railway outside India acceptable? Transient processing versus storage

- **The rule.** RBI's Digital Lending Directions, 2025 (issued 8 May 2025) require REs to ensure that borrower data collected through DLAs and LSPs is **stored only in servers located in India**.
  - Secondary sources consistently report that data processed abroad must be **deleted from the foreign servers and brought back to India within 24 hours** of processing.
  - They also report that LSPs and DLAs may store only minimal data, and no biometrics unless a law permits it.
  - **[likely]**: the primary text could not be fetched here, and paragraph numbers are unverified. Sources: [RBI – Digital Lending Directions, 2025](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12848) (8 May 2025, primary, not fetched); [S.S. Rana – RBI introduced Digital Lending Direction, 2025](https://ssrana.in/articles/rbi-introduced-digital-lending-direction-2025/) (secondary); [Mondaq – Regulatory reset](https://www.mondaq.com/india/financial-services/1632398/digital-lending-in-india-a-regulatory-reset-under-the-reserve-bank-of-india-digital-lending-directions-2025) (secondary).
  - Secondary commentary says the 28 Nov 2025 consolidation carried DL provisions into the RE-wise "Credit Facilities" Directions. The current paragraph should be confirmed by the regulatory agent. **[unverified]** [Vinod Kothari – The Great Consolidation](https://vinodkothari.com/2025/10/the-great-consolidation/) (secondary).
- **CERT-In.** The Directions under s.70B(6) of the IT Act, dated 28 Apr 2022, require all body corporates to keep logs of all ICT systems for a **rolling 180 days within Indian jurisdiction**, to report incidents within **6 hours**, and to synchronise clocks to NIC/NPL NTP (or traceable sources). CERT-In's FAQs reportedly allow a copy of the logs outside India provided they can be produced to CERT-In in reasonable time. **[likely; primary not fetched this session]**
- **Assessment.** **[interpretation]** In-memory request processing in Singapore is arguably "transient processing" and is not storage. But a Railway deployment also creates **persistent offshore copies** that last well beyond 24 hours:
  1. Railway log and trace retention (30 to 90 days), including client IPs and any PII that reaches stdout;
  2. any Railway volume, bucket, Postgres or Redis instance (Singapore at best);
  3. queue and cache contents if Redis or BullMQ were hosted on Railway.

  Each of these is offshore storage of borrower-linked data and is hard to defend to an RE whose own outsourcing and IT-risk directions push localisation, audit rights and regulator access down to vendors.

- **Other drawbacks.** Every API transaction that sets RLS context costs several Singapore↔Mumbai round trips (roughly 55 to 70 ms RTT, **[unverified estimate]**). The static egress IPs are not Indian.
- **Recommendation.**
  - Use Railway for dev, preview and staging with **synthetic data only**.
  - If Railway must carry production for a short bridge:
    - make it strictly stateless, with no volumes, buckets, Redis or Railway Postgres;
    - redact PII structurally from logs;
    - set `cacheControl` / no-store on responses;
    - export OTel to an India-hosted collector;
    - get the partner RE's written acceptance.
  - Otherwise, and preferably, **move production compute to AWS ap-south-1 before go-live** so that lenders' IS audits happen only once.

### 3. Supabase (Mumbai)

- **Residency.** Supabase states: "each Supabase project is deployed into the region the customer specifies… All data will remain within the chosen region". Read replicas are the exception: their regions are the customer's responsibility. **[confirmed]** [Supabase – SOC 2 Compliance](https://supabase.com/docs/guides/security/soc-2-compliance) (accessed 2026-10-10).
  - Backups and PITR use WAL-G to "our storage servers" / S3. The bucket's region is not stated separately. **[unverified; ask Supabase in writing]** [Database Backups](https://supabase.com/docs/guides/platform/backups).
  - Where Supabase platform logs are stored is not documented in the pages reviewed. **[unverified]**
  - A project's region cannot be changed. The only route is to create a new project and migrate. **[confirmed]** [Change Project Region](https://supabase.com/docs/guides/troubleshooting/change-project-region-eWJo5Z).
  - Supabase lists only ap-south-1 for India (for example in the Edge Function region list). In-country disaster recovery to a second Indian region is therefore not available on Supabase itself. **[likely]** [Regional Invocations](https://supabase.com/docs/guides/functions/regional-invocation).
- **Point-in-time recovery (PITR).** Available on Pro, Team and Enterprise as an add-on: 7, 14 or 28 days, at about $100, $200 or $400 per month. It needs at least Small compute, gives a worst-case RPO of about 2 minutes, and replaces daily backups when enabled. **[confirmed]** [Backups](https://supabase.com/docs/guides/platform/backups).
- **Read replicas.** GA on Pro and above. Up to 2 replicas below XL compute, up to 5 at XL or above. The API load balancer geo-routes requests, and **Auth is always served by the primary**. Replicas must be pinned to ap-south-1. **[confirmed]** [Read Replicas](https://supabase.com/docs/guides/platform/read-replicas).
- **Pooling.**
  - Shared Supavisor: session mode on port 5432, transaction mode on 6543, IPv4.
  - Dedicated PgBouncer on paid plans: transaction mode only, IPv6 unless the IPv4 add-on is bought.
  - Transaction mode does not support prepared statements. **[confirmed]** [Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres).
  - `SET LOCAL` and `set_config(…, true)` are transaction-scoped and work correctly through transaction poolers. **[interpretation]**
- **Feature maturity, from Supabase's feature-status table.** **[confirmed]** [Features](https://supabase.com/docs/guides/getting-started/features).
  - GA: PITR, read replicas, SSO with SAML, third-party auth.
  - Beta: Branching, Auth Hooks, PrivateLink.
  - Public alpha: Vault, log drains, Terraform provider.
- **Encryption.** **pgsodium is "pending deprecation"**: "DOES NOT RECOMMEND any new usage", and Supabase advises against Transparent Column Encryption and server key management. Vault's interface is kept, but its internals are moving off pgsodium. **[confirmed]** [pgsodium](https://supabase.com/docs/guides/database/extensions/pgsodium).
  - Recommendation: application-level envelope encryption with KMS for PAN, bank account and Aadhaar reference fields, plus HMAC blind indexes for lookup.
- **Auth.**
  - Hooks available on Free and Pro include **Send SMS**, **Custom Access Token** and Send Email. MFA-verification and password-verification hooks require Team or Enterprise. HTTP hooks follow Standard Webhooks signing and have a 5-second budget. **[confirmed]** [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks).
    - Use Send SMS to route OTPs through a TRAI-DLT-registered Indian SMS gateway. **[interpretation]**
    - Use Custom Access Token to add `udofin_role`, `lender_id` and staff scopes to JWT claims.
  - Asymmetric signing keys (RS256/ES256) are recommended, with a JWKS endpoint at `/auth/v1/.well-known/jwks.json`. The Fastify API can verify tokens with `jose` and no shared secret. **[confirmed]** [OAuth 2.1 flows / token validation](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows).
  - SAML 2.0 SSO is available on Pro and above at $0.015 per SSO MAU over quota. Multi-tenant SAML is supported, and `sso_provider_id` appears in the JWT for RLS, which suits per-lender IdPs on the lender portal and Google or Entra for ops staff. **[confirmed]** [SAML SSO](https://supabase.com/docs/guides/auth/enterprise-sso/auth-sso-saml).
- **Storage.**
  - S3-compatible API, image transforms and resumable uploads are GA. **[confirmed]**
  - **Smart CDN is enabled automatically on Pro and above and caches signed-URL responses at the CDN edge.** Revoking or expiring a token does _not_ purge the cached response, and propagation is global. **[confirmed]** [Smart CDN](https://supabase.com/docs/guides/storage/cdn/smart-cdn).
  - For KYC documents, eSigned agreements and bank statements this creates an offshore-cache and access-control risk. Serve them through the API (no-store) or from S3 ap-south-1 with pre-signed URLs. **[interpretation]**
- **Edge Functions.** These run in the region nearest the caller unless `x-region` / `forceFunctionRegion` is set. A call from Railway Singapore would therefore execute in ap-southeast-1. Pin Edge Functions to `ap-south-1`, or prefer Postgres-function hooks. **[confirmed]** [Regional Invocations](https://supabase.com/docs/guides/functions/regional-invocation).
- **Log drains.** Pro and above, about $60 per drain per month plus $0.20 per million events. Destinations include OTLP, Loki, S3 (your own bucket and region), Syslog over TLS, Datadog, Sentry and **Last9, which offers an "AP South 1" region**. **[confirmed]** [Log Drains](https://supabase.com/docs/guides/observability/log-drains).
- **Compliance.** SOC 2 Type 2, with the report available to Team and Enterprise plans. HIPAA is available through a BAA plus add-on. ISO 27001 is not mentioned in the docs reviewed. **[ISO unverified]** [Supabase Security](https://supabase.com/docs/guides/security).

### 4. Finbyx in Tokyo: confirmed residency issue

- The Supabase Management API (`list_projects`, run 2026-10-10) returned project `finbyx` with region **`ap-northeast-1`**, status ACTIVE_HEALTHY, Postgres 17.6.1.155, created 2026-07-04. It is in the same organisation as `Udofin-app`, which is in `ap-south-1`. **[confirmed]**
- Finbyx is positioned as an LOS/LMS with accounting, CIC reporting and RBI reporting for Indian NBFCs and UCBs. Any borrower or loan data there sits outside India. **[interpretation]**
- Required action:
  1. Create a new project in ap-south-1. A region cannot be changed in place.
  2. Migrate the data.
  3. Rotate keys and URLs.
  4. Delete the Tokyo project; per the backups docs, deleting a project removes its S3 backups.
  5. If real data was ever stored there, record it as a compliance incident with an inventory of what was held.

### 5. AWS migration path (ap-south-1 primary, ap-south-2 Hyderabad for DR)

- **Service availability.** AWS's availability catalogue shows the following in **both** ap-south-1 and ap-south-2: Fargate, EKS, Aurora, RDS for PostgreSQL, SQS, KMS, Secrets Manager, WAF, CloudWatch, EventBridge, X-Ray, ElastiCache and Amazon Managed Prometheus. **[confirmed]**
  - **Amazon Managed Grafana** is "not expanding" in either Indian region. **[confirmed]** [AWS regional availability](https://aws.amazon.com/about-aws/global-infrastructure/regional-product-services/) (via AWS Knowledge MCP, 2026-10-10).
- **App Runner moved to maintenance**, closed to new customers, effective 30 Apr 2026. Do not choose it. **[confirmed]** [AWS Service Availability Updates](https://aws.amazon.com/about-aws/whats-new/2026/03/aws-service-availability/) (Mar 2026).
  - Its practical successor is **Amazon ECS Express Mode**, available wherever ECS and Fargate run, with ALB, domains and autoscaling set up in one command. **[confirmed]** [ECS Express Mode](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html).
- **Compute.** Recommend **ECS on Fargate**, starting with Express Mode for the API and plain ECS services for workers, plus EventBridge Scheduler for cron. EKS adds a control plane and Kubernetes operating burden that a seed-stage team does not need. **[interpretation]**
- **Database.** Aurora PostgreSQL supports **17.11 and 18.6** (Sep 2026). **[confirmed]** [Aurora PG 18.6/17.11](https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-aurora-postgresql-18-6-17-11-16-15-15-19-14-24/).
  - Moving off Supabase also means replacing Supabase Auth, because GoTrue is bound to the Supabase database. That means self-hosted GoTrue or Cognito.
  - Recommended phasing:
    1. Move compute, files (S3), keys (KMS) and observability to AWS Mumbai, and keep Supabase as database and auth, reached over PrivateLink (beta) or network restrictions plus static NAT IPs.
    2. Move the database to Aurora only if needed, for example for cross-region DR to Hyderabad, which Supabase cannot provide in India. **[interpretation]**
- **Files and encryption.** S3 in ap-south-1 with SSE-KMS (customer-managed keys), Block Public Access, Object Lock for audit and log archives, and short-lived pre-signed URLs with no CDN in the path for KYC artefacts. Use KMS data keys for field-level envelope encryption. **[interpretation]**
- **Edge and network.** Put a regional ALB with WAF in front of the API, and avoid caching API or KYC responses in CloudFront. Keep CloudWatch Logs retention at 180 days or more, then export to S3 under Object Lock (CERT-In). Use Secrets Manager with GitHub OIDC for deployments. **[interpretation]**
- **IaC.** Recommend **OpenTofu** (MPL-2.0; latest v1.13.1, 1 Oct 2026 per [GitHub releases](https://github.com/opentofu/opentofu/releases), year inferred) or Terraform. Either one module tree can cover AWS, Supabase (provider still public alpha), Cloudflare and observability. CDK fits only if the stack becomes AWS-only. Until migration, Railway configuration goes into `.railway/railway.ts`. **[interpretation]**

### 6. Background jobs and durable financial workflows

| Option          | Version (npm, 2026-10) | Licence                                              | Fit for Udofin                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ---------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pg-boss**     | 12.37.1                | MIT                                                  | Jobs created **inside the existing DB transaction**, with adapters for Kysely, Drizzle, Knex and Prisma. Also: DLQ with redrive, retries with backoff, cron/RRULE, dependency flows, OTel, multi-master. Needs Node ≥22.12. The project is single-maintainer. **[confirmed]** [pg-boss README](https://github.com/timgit/pg-boss)                                          |
| Graphile Worker | 0.18.0                 | MIT                                                  | `add_job()` in SQL, so enqueue is transactional. Very fast LISTEN/NOTIFY design, which needs a session or direct connection. Node ≥22.18. **[confirmed versions/licence; design: likely]**                                                                                                                                                                                 |
| BullMQ + Redis  | 6.3.12                 | MIT                                                  | Adds a second stateful store with no atomic enqueue alongside Postgres writes. Redis on Railway would sit in Singapore. Not preferred.                                                                                                                                                                                                                                     |
| **Temporal**    | SDK 1.24.0             | MIT                                                  | The best fit for long sagas: application to offers to eSign to disbursement to eNACH, and collections. **Temporal Cloud has `aws-ap-south-1` and `aws-ap-south-2`, plus `gcp-asia-south1`**, so history can stay in India. **[confirmed]** [Temporal Cloud AWS regions](https://github.com/temporalio/documentation/blob/main/docs/cloud/references/regions/awsregions.md) |
| Inngest         | 4.23.0                 | Server SSPL plus delayed Apache-2.0; SDKs Apache-2.0 | Cloud-first, and event payloads would carry PII offshore. Self-hosting is possible. **[confirmed licence]**                                                                                                                                                                                                                                                                |
| Trigger.dev     | 4.7.3                  | Apache-2.0                                           | Cloud-first. Self-hosting via Docker or Helm. **[confirmed]**                                                                                                                                                                                                                                                                                                              |
| Restate         | 1.17.3                 | Server **BSL 1.1**                                   | Promising but young, and the licence is restrictive. **[confirmed licence]**                                                                                                                                                                                                                                                                                               |

**Recommendation.** **[interpretation]**

- Write each domain change and an `outbox` row in the **same Postgres transaction**. Insert the pg-boss job through its Kysely adapter in that transaction as well, or have a relay drain the outbox.
- Make every handler idempotent, keyed on `(aggregate_id, event_id)`, and keep idempotency keys on external calls to Surepass, payment gateways and lender APIs.
- Adopt Temporal Cloud (Mumbai) only when the multi-lender orchestration and collections state machines become hard to reason about as chained jobs.

### 7. Backend framework, data access and the RLS pattern

- **Framework.** Keep **Fastify 5** (5.12.5; 6.0 is alpha), with `fastify-type-provider-zod` 7.0.0 (peers: zod ≥4.1.5, fastify ^5.5, @fastify/swagger ≥9.5.1) and `@fastify/swagger`, which can emit **OpenAPI 3.1.0 or 3.2.0**. **[confirmed: npm registry and the [fastify-swagger README](https://github.com/fastify/fastify-swagger)]**
  - NestJS 12.1.2 adds DI and decorator weight without a compliance benefit.
  - Hono 4.13 (v5 is an RC) is edge-oriented.
  - Express 5.3.0 is stable but has a weaker type and plugin story for this use.
  - Structure: a modular monolith in which `packages/domain` holds pure logic, `packages/adapters` holds ports (Surepass, lender LMS, payments, eSign) and `packages/contracts` holds zod/OpenAPI. That layout already exists. **[interpretation]**
- **Data access.** Recommend **Kysely 0.29.6** (Node ≥22) for typed SQL, with raw SQL for reports.
  - Each request runs `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', $jwt_json, true); …; COMMIT`, so Supabase `auth.uid()` and the RLS policies apply to the API exactly as they do to PostgREST. **[interpretation; standard Supabase pattern]**
  - Use the dedicated pooler or a direct connection from long-lived services. Turn prepared statements off if you go through Supavisor transaction mode.
  - Drizzle (0.45.4 stable, 1.0 in RC) is acceptable, but 1.0 brings API churn. Prisma (client 7.10.0; 8.0 in RC) makes per-transaction RLS context awkward.
  - Keep **Supabase CLI SQL migrations** as the single schema source and generate Kysely types from them. **[interpretation]**
- **Service role.** Never use the service-role key in request paths. Restrict it to migrations and specific back-office jobs, and log every use. **[interpretation]**

### 8. TypeScript 7

- npm `latest` is `typescript@7.0.2`, but **typescript-eslint 8.71.1 declares a peer of `typescript >=4.8.4 <6.1.0`**, and v8.65.0 (2026-07-20) added a _warning when TS 7 is detected_. **[confirmed]** [npm registry]; [typescript-eslint v8.65.0](https://github.com/typescript-eslint/typescript-eslint/releases/tag/v8.65.0).
- The typescript-go README marks the native port complete for checking, emit, watch and build mode, and the language service "nearly" complete, but marks the **API "Not ready"**. Type-aware linters and other tools that use the compiler API cannot run on TS 7 yet. **[confirmed]** [microsoft/typescript-go](https://github.com/microsoft/typescript-go).
- **Recommendation.**
  - Keep `typescript: ~6.0.3` across the workspace, as the repo already does.
  - Add a Renovate/Dependabot rule so that `latest` does not pull in 7.x.
  - Optionally run `tsgo` (7.x under an alias) as a fast, non-gating CI type-check.
  - Next 16.4 and Expo 57 transpile with SWC or Babel, so the TS version only matters for type-checking and linting. **[interpretation]**

### 9. Observability, secrets and the monorepo

- **Observability.**
  - Use OpenTelemetry (`@opentelemetry/sdk-node` 0.223.0) feeding an **OTel Collector in ap-south-1**.
  - Backends that keep data in India:
    - self-hosted Grafana/Loki/Tempo/Mimir on AWS Mumbai;
    - Amazon Managed Prometheus plus CloudWatch/X-Ray in ap-south-1;
    - Last9 (AP South 1). **[interpretation]**
  - **Sentry SaaS stores event data only in the US (Iowa) or EU (Frankfurt), and some metadata always in the US.** **[confirmed]** [Sentry – Data Storage Location](https://github.com/getsentry/sentry-docs/blob/master/docs/organization/data-storage-location/index.mdx). Use self-hosted Sentry in Mumbai, or use the SaaS only with aggressive `beforeSend` scrubbing and no PII.
  - Datadog sites listed by Supabase (US1/3/5, EU, AP1, AP2, UK1, FED) include none in India. **[confirmed list; that AP1/AP2 are Japan/Australia is likely]**
  - Whether Grafana Cloud has an India region could not be verified. **[unverified]**
- **Secrets.** Use Railway sealed variables now, then AWS Secrets Manager with KMS (ap-south-1) after migration. Infisical self-hosted is an option only if you run multi-cloud. Doppler and Infisical Cloud are SaaS outside India. Secrets are not borrower data, but RE auditors will ask where they are held. **[interpretation]**
- **Monorepo.**
  - Keep pnpm and Turborepo (turbo 2.11.7). Nx 23.3 is not needed; enforce module boundaries with ESLint rules instead.
  - The repo pins `packageManager: pnpm@10.28.0` while 12.10.1 is current. Plan the upgrade deliberately, and enable supply-chain controls: `minimumReleaseAge` and an allowlist for lifecycle scripts. **[feature names likely]**
- **API contracts.**
  - For partner and lender-facing APIs: OpenAPI 3.1, with zod 4 as the source of truth, plus versioned paths, idempotency keys and **Standard Webhooks**-signed callbacks (the same scheme Supabase hooks use).
  - tRPC at most for internal portals; it is unsuitable for external partners.
  - Events: a **CloudEvents 1.0** envelope for outbox events and webhooks, documented in **AsyncAPI 3.0**. **[interpretation]**

### 10. Apache Fineract as an LMS/accounting engine

- **Maturity.**
  - Apache top-level project under the Apache-2.0 licence, built on Java and Spring Boot with Spring Batch close-of-business (COB) jobs.
  - **PostgreSQL is now the standard database; MySQL and MariaDB are deprecated (FSIP-9).**
  - External business events can be published to Kafka or JMS.
  - Recent releases: 1.15.0 (14 Jul), 1.14.0 (22 Dec), 1.13.0 (20 Oct). Years inferred as 2026 and 2025. **[confirmed versions; years likely]**
  - The README warns that a production deployment "can be complex, costly, and time-consuming" and that the project's Docker images are "NOT production-ready". **[confirmed]** [apache/fineract](https://github.com/apache/fineract); [releases](https://github.com/apache/fineract/releases).
- **Fit for Indian NBFCs.** **[interpretation]** It provides generic loan products, a general ledger and delinquency buckets. India-specific behaviour would all have to be built:
  - IRACP NPA/SMA day-end classification and upgrade rules;
  - CIC reporting formats;
  - RBI returns;
  - GST and TDS on fees;
  - NACH and UPI AutoPay;
  - co-lending split ledgers;
  - DLG/FLDG accounting;
  - KFS/APR computation;
  - penal-charges treatment;
  - Ind AS 109 ECL.

  The team would also need JVM skills it does not have.

- **Recommendation.** **[interpretation]**
  - Udofin, as an LSP, should **not** embed an LMS of record for lenders, because loan accounting is the RE's function.
  - Integrate with each RE's LMS through an `LmsPort` adapter: Finbyx first, then generic REST.
  - Offer Finbyx, as a separate product with a separate contract, separate India-hosted infrastructure and a separate audit trail, to lenders that have no LMS.
  - Fineract is at most a candidate engine _inside Finbyx's_ roadmap, not inside Udofin.

### 11. "Latest technologies": worth adopting versus hype

- **Adopt now.**
  - Supabase asymmetric JWT keys with JWKS.
  - Custom Access Token hook.
  - SAML SSO for staff and lenders.
  - PITR.
  - Postgres 17 features (`MERGE … RETURNING`, `JSON_TABLE`).
  - OpenTelemetry end-to-end.
  - zod 4 schemas generating OpenAPI 3.1.
  - ECS Express Mode or Fargate in Mumbai.
  - KMS envelope encryption.
  - OpenTofu.
  - The pg-boss outbox pattern.
  - **Amazon Bedrock "India geo" cross-Region inference** for the borrower AI agent. Claude and OpenAI models are processed within Mumbai and Hyderabad. **[confirmed]** [Bedrock Claude in India](https://aws.amazon.com/about-aws/whats-new/2026/09/claude-region-expansion-in-sk/) (Sep 2026); [Bedrock OpenAI in India](https://aws.amazon.com/about-aws/whats-new/2026/08/amazon-bedrock-openai-india-v1/) (Aug 2026).
- **Adopt when needed.** Temporal Cloud in Mumbai; Supabase read replicas in ap-south-1; Supabase PrivateLink (beta) after the AWS move.
- **Hold.**
  - TypeScript 7 in the lint pipeline.
  - Fastify 6 alpha, Hono 5 RC, Drizzle 1.0 RC and Prisma 8 RC.
  - Supabase Vault (alpha) or pgsodium for application secrets.
  - Running financial logic in edge runtimes or on edge functions.
  - EKS or microservices at this stage.
  - Inngest or Trigger.dev cloud, or Restate, for PII-bearing workflows.
  - Multi-region active-active (not possible within India on Supabase).

## Requirements-to-controls

| ID     | Requirement                                                                  | Source (instrument + para/section if verified)                                                                                  | Applies to                               | Status                                         | System control in Udofin                                                                                                                                                               | Evidence to retain                                                                                 | Test case                                                                                                                                                     |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INF-01 | Borrower data stored only on servers in India                                | RBI (Digital Lending) Directions, 2025, 8 May 2025 (data-storage para; number unverified; check post-28-Nov-2025 consolidation) | RE (ensure), LSP (contractual flow-down) | Likely                                         | All stateful stores in ap-south-1 (Supabase Udofin-app, S3 ap-south-1). IaC region allowlist `[ap-south-1, ap-south-2]`. No Railway volumes, buckets, Postgres or Redis in production. | Infra inventory, region exports (Supabase `list_projects`, AWS Config), vendor region attestations | CI job queries the Supabase Management API and AWS Config and fails if any production resource is outside the allowlist. Today it **would fail on `finbyx`**. |
| INF-02 | Processing outside India only if transient, with deletion abroad within 24 h | Same Directions (reported 24-hour rule; unverified)                                                                             | RE, LSP                                  | Likely                                         | Preferred: production compute in AWS Mumbai. Bridge: stateless Railway with PII-free logs.                                                                                             | Log-redaction test reports, Railway retention settings                                             | Inject test PAN, Aadhaar and mobile into a request and assert absence (regex scan) in Railway logs and traces                                                 |
| INF-03 | Finbyx data in India                                                         | INF-01 plus RE outsourcing expectations                                                                                         | Finbyx (TSP), RE                         | Confirmed gap                                  | New ap-south-1 project, migration, delete Tokyo project                                                                                                                                | Migration record, deletion confirmation, data inventory                                            | `list_projects` shows no ap-northeast-1 project                                                                                                               |
| INF-04 | ICT logs kept 180 days within Indian jurisdiction                            | CERT-In Directions under s.70B(6), 28 Apr 2022 (para unverified)                                                                | Udofin (body corporate), all vendors     | Likely                                         | OTel Collector and Supabase log drain into an India store with ≥180-day retention, S3 Object Lock archive                                                                              | Retention configuration, archive manifests                                                         | Retrieve a log line older than 180 days from the India archive                                                                                                |
| INF-05 | Report cyber incidents to CERT-In within 6 h                                 | CERT-In Directions, 28 Apr 2022                                                                                                 | Udofin                                   | Likely                                         | Alerting plus incident runbook with a 6-hour clock and named PoC                                                                                                                       | Runbook, drill records                                                                             | Tabletop drill, measuring time to draft the report                                                                                                            |
| INF-06 | Clock synchronisation (NIC/NPL or traceable)                                 | CERT-In Directions, 28 Apr 2022                                                                                                 | Udofin                                   | Likely                                         | Amazon Time Sync / NTP config documented; logs in UTC with offset                                                                                                                      | Configuration screenshots                                                                          | Compare drift across services                                                                                                                                 |
| INF-07 | LSP stores only minimal data; no biometrics unless a law permits             | RBI DL Directions, 2025 (para unverified)                                                                                       | LSP, DLA                                 | Likely                                         | Schema-level data classification; RE-owned data held in RE-scoped schemas under RLS; no biometric columns                                                                              | Data map, DPIA                                                                                     | Schema lint forbids flagged column names; RLS tests per lender                                                                                                |
| INF-08 | KYC artefacts not cached offshore; access revocable                          | Supabase Smart CDN behaviour (vendor doc) plus INF-01                                                                           | Udofin                                   | Confirmed risk                                 | KYC documents in S3 ap-south-1 or proxied with `no-store`; no Supabase Storage signed URLs to clients for KYC                                                                          | Storage design record                                                                              | An expired signed or pre-signed URL returns 4xx with no cache hit                                                                                             |
| INF-09 | Edge compute stays in India                                                  | Supabase regional invocation doc                                                                                                | Udofin                                   | Confirmed risk                                 | All Edge Function calls pinned with `x-region: ap-south-1`; prefer Postgres hooks                                                                                                      | Configuration                                                                                      | Check the `x-sb-edge-region` response header equals ap-south-1                                                                                                |
| INF-10 | Read replicas only in India                                                  | Supabase SOC 2 doc (customer responsibility)                                                                                    | Udofin                                   | Confirmed                                      | Replica region allowlist in IaC                                                                                                                                                        | Replica inventory                                                                                  | Same check as INF-01                                                                                                                                          |
| INF-11 | Backups restorable and in-region                                             | Supabase Backups/PITR doc                                                                                                       | Udofin                                   | Confirmed (region of backup bucket unverified) | PITR 14 days, quarterly restore drill to a new project                                                                                                                                 | Drill reports, Supabase written confirmation of backup region                                      | Restore to timestamp T, then reconcile ledgers                                                                                                                |
| INF-12 | Vendor assurance for RE audits                                               | RE outsourcing directions (flow-down); vendor trust centres                                                                     | RE, LSP                                  | Confirmed (vendor certificates)                | Collect SOC 2 Type II (Supabase on Team/Enterprise plan; Railway trust centre), DPAs, sub-processor lists                                                                              | Reports with dates                                                                                 | Annual vendor review checklist                                                                                                                                |
| INF-13 | Field-level protection of PAN, bank accounts and Aadhaar references          | DPDP Act 2023 s.8(5) reasonable security safeguards (likely); sound practice                                                    | Udofin                                   | Recommendation                                 | KMS envelope encryption plus HMAC blind index; no pgsodium                                                                                                                             | Key policy, rotation logs                                                                          | DB dump shows only ciphertext for tagged columns                                                                                                              |
| INF-14 | AI agent inference in India                                                  | INF-01/02                                                                                                                       | Udofin                                   | Recommendation                                 | Bedrock India geo cross-Region inference profiles only; no direct calls to US LLM APIs with borrower data                                                                              | Model-invocation logs (ap-south-1)                                                                 | Egress firewall blocks non-Bedrock LLM endpoints                                                                                                              |
| INF-15 | Push and observability payloads carry no PII offshore                        | INF-01, DPDP                                                                                                                    | Udofin                                   | Interpretation                                 | Generic push text; Sentry `beforeSend` scrubbing or self-hosted Sentry                                                                                                                 | Payload templates                                                                                  | Snapshot test of push payloads                                                                                                                                |
| INF-16 | Partner IP allowlisting from India                                           | Partner API terms (case by case)                                                                                                | Udofin                                   | Interpretation                                 | AWS NAT Gateway Elastic IPs in Mumbai                                                                                                                                                  | IP register shared with partners                                                                   | Connectivity check from each egress IP                                                                                                                        |

## Challenges to the owner's plan

1. **"Backend Node.js on Railway."** Railway has no India region and no BYOC, and it retains logs and traces offshore for 30 to 90 days (Railway docs, 2026; RBI DL Directions 2025 data storage **[likely]**). _Alternative:_ keep Railway for non-production with synthetic data, and run production compute on AWS ap-south-1 (ECS Express Mode or Fargate) from day one of live lending.
2. **"AWS later."** Migrating after REs have audited a Railway setup forces a second round of RE IS audits and a live cut-over of financial workflows. _Alternative:_ move compute, files, keys and logs to AWS Mumbai before go-live, and keep Supabase as database and auth while it meets the need.
3. **Finbyx in Tokyo (confirmed).** This conflicts with the India data-storage requirement for any RE data. _Alternative:_ recreate it in ap-south-1 now, migrate, and delete the Tokyo project and its backups.
4. **Supabase defaults that leak data out of region.** The Smart CDN caches signed URLs globally and keeps them after expiry, Edge Functions run in the nearest region, and replicas can be placed anywhere (Supabase docs). _Alternative:_ follow INF-08 to INF-10.
5. **"Latest technologies."** `typescript@latest` is 7.0.2, but the toolchain cannot use it yet (typescript-eslint peer <6.1.0; TS 7 API not ready). _Alternative:_ pin 6.0.x and add an update-bot rule.
6. **Sentry, Datadog and US-hosted SaaS for logs and errors.** Data at rest would be in the US or EU only (Sentry docs). _Alternative:_ an India-hosted OTel stack, self-hosted Sentry in Mumbai, or Last9 AP South 1.
7. **Using Fineract (or any LMS) inside Udofin.** Loan accounting of record belongs to the RE. _Alternative:_ integrate lenders' LMSs through adapters, and offer Finbyx (India-hosted) separately.
8. **Redis/BullMQ, Inngest or Trigger.dev cloud for financial jobs.** These add offshore or extra state stores and lose transactional enqueue. _Alternative:_ a Postgres outbox with pg-boss, then Temporal Cloud in Mumbai if needed.
9. **`railway.json`/`railway.toml`.** These stop being read on 2026-12-01. _Alternative:_ `.railway/railway.ts` for any Railway configuration that remains.

## Open questions

1. Does the current RBI text, after the 28 Nov 2025 consolidation, still contain the 24-hour offshore-processing allowance? Does "data" cover operational logs and IP addresses? (Legal review.)
2. Can Supabase confirm in writing that WAL-G/PITR backup buckets, platform logs (API and Postgres logs) and support tooling stay in ap-south-1? Can Smart CDN be disabled per bucket or project?
3. What exactly is in the Finbyx Tokyo project today: real RE or borrower data, or test data only?
4. Will partner REs accept vendor SOC 2 reports (Supabase, Railway), or do they require India-hosted compute and on-site audit rights in the LSP agreement?
5. Budget and plan: Supabase Team (SOC 2 report access, MFA and password hooks) versus Pro, PITR retention period, and log-drain costs.
6. Which partners (KYC, CKYC, NSDL/CDSL, sponsor banks, NPCI) require Indian source IPs or mTLS?
7. Is Temporal Cloud worth adopting now for the multi-lender application saga, or after the first two lenders?

## Self-verification

| #   | Claim                                                                                    | Check against                                                | Verdict                                                                                                              |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Railway has four regions (California, Virginia, Amsterdam, Singapore) and none in India  | Railway Docs – Regions and Edge Networking (via Railway MCP) | **Confirmed**                                                                                                        |
| 2   | Railway has no BYOC                                                                      | Railway docs FAQ                                             | **Confirmed**                                                                                                        |
| 3   | Railway log retention is Pro 30 days, Enterprise up to 90, with no log drain             | Railway Docs – Logs                                          | **Confirmed**                                                                                                        |
| 4   | Railway config-as-code is deprecated with a 2026-12-01 hard cutoff                       | Railway Docs – IaC                                           | **Confirmed**                                                                                                        |
| 5   | Finbyx Supabase project is in ap-northeast-1                                             | Supabase Management API `list_projects` (2026-10-10)         | **Confirmed**                                                                                                        |
| 6   | Supabase data stays in the chosen region, and replicas are the customer's responsibility | Supabase SOC 2 doc                                           | **Confirmed**. The backup-bucket region and log location could not be verified, and the body was marked accordingly. |
| 7   | Smart CDN caches signed URLs, and an expired token is not purged                         | Supabase Smart CDN doc                                       | **Confirmed**                                                                                                        |
| 8   | App Runner moved to maintenance on 30 Apr 2026                                           | AWS What's New 2026/03                                       | **Confirmed**                                                                                                        |
| 9   | Aurora PostgreSQL supports 17.11 and 18.6                                                | AWS What's New 2026/09                                       | **Confirmed**                                                                                                        |
| 10  | typescript-eslint peer is TS <6.1.0, and the TS 7 API is "not ready"                     | npm registry; typescript-go README                           | **Confirmed**                                                                                                        |
| 11  | Temporal Cloud has Mumbai and Hyderabad regions                                          | temporalio/documentation awsregions.md                       | **Confirmed**                                                                                                        |
| 12  | Sentry SaaS is US or EU only                                                             | getsentry/sentry-docs                                        | **Confirmed**                                                                                                        |
| 13  | RBI DL "servers in India" rule and 24-hour rule                                          | rbi.org.in blocked; secondary sources only                   | **Could not verify against primary.** Kept as [likely], with paragraph numbers omitted.                              |
| 14  | CERT-In 180 days in Indian jurisdiction and 6-hour reporting                             | cert-in.org.in blocked                                       | **Could not verify this session.** Kept as [likely].                                                                 |

## Sources

- Railway Docs – Regions, https://docs.railway.com/deployments/regions (accessed 2026-10-10), primary (vendor)
- Railway Docs – Edge Networking, https://docs.railway.com/networking/edge-networking (accessed 2026-10-10), primary (vendor)
- Railway Docs – Railway Metal, https://docs.railway.com/platform/railway-metal (accessed 2026-10-10), primary (vendor)
- Railway Docs – Logs, https://docs.railway.com/observability/logs (accessed 2026-10-10), primary (vendor)
- Railway Docs – Infrastructure as Code, https://docs.railway.com/infrastructure-as-code (accessed 2026-10-10), primary (vendor)
- Railway Docs – Compliance, https://docs.railway.com/enterprise/compliance (accessed 2026-10-10), primary (vendor)
- Railway Docs – Outbound Networking, https://docs.railway.com/networking/outbound-networking (accessed 2026-10-10), primary (vendor)
- Railway Docs – railway bucket, https://docs.railway.com/cli/bucket (accessed 2026-10-10), primary (vendor)
- Railway Docs – Railway vs Northflank (BYOC FAQ), https://docs.railway.com/platform/compare-to-northflank (accessed 2026-10-10), primary (vendor)
- Railway Central Station – Add India Region (feature request), https://station.railway.com/feedback/add-india-region-for-deployment-25dee5be (2026), secondary (search snippet)
- Supabase – SOC 2 Compliance, https://supabase.com/docs/guides/security/soc-2-compliance (accessed 2026-10-10), primary (vendor)
- Supabase – Database Backups, https://supabase.com/docs/guides/platform/backups (accessed 2026-10-10), primary (vendor)
- Supabase – Read Replicas, https://supabase.com/docs/guides/platform/read-replicas (accessed 2026-10-10), primary (vendor)
- Supabase – Features / feature status, https://supabase.com/docs/guides/getting-started/features (accessed 2026-10-10), primary (vendor)
- Supabase – pgsodium (pending deprecation), https://supabase.com/docs/guides/database/extensions/pgsodium (accessed 2026-10-10), primary (vendor)
- Supabase – Auth Hooks, https://supabase.com/docs/guides/auth/auth-hooks (accessed 2026-10-10), primary (vendor)
- Supabase – OAuth 2.1 flows / JWKS, https://supabase.com/docs/guides/auth/oauth-server/oauth-flows (accessed 2026-10-10), primary (vendor)
- Supabase – SAML SSO, https://supabase.com/docs/guides/auth/enterprise-sso/auth-sso-saml (accessed 2026-10-10), primary (vendor)
- Supabase – Smart CDN, https://supabase.com/docs/guides/storage/cdn/smart-cdn (accessed 2026-10-10), primary (vendor)
- Supabase – Regional Invocations, https://supabase.com/docs/guides/functions/regional-invocation (accessed 2026-10-10), primary (vendor)
- Supabase – Log Drains, https://supabase.com/docs/guides/observability/log-drains (accessed 2026-10-10), primary (vendor)
- Supabase – Connect to your database, https://supabase.com/docs/guides/database/connecting-to-postgres (accessed 2026-10-10), primary (vendor)
- Supabase – Change Project Region, https://supabase.com/docs/guides/troubleshooting/change-project-region-eWJo5Z (accessed 2026-10-10), primary (vendor)
- Supabase Management API `list_projects` output (2026-10-10), primary
- AWS – Service Availability Updates (App Runner to maintenance), https://aws.amazon.com/about-aws/whats-new/2026/03/aws-service-availability/ (Mar 2026), primary
- AWS – ECS Express Mode, https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html (accessed 2026-10-10), primary
- AWS – Aurora PostgreSQL 18.6/17.11, https://aws.amazon.com/about-aws/whats-new/2026/09/amazon-aurora-postgresql-18-6-17-11-16-15-15-19-14-24/ (Sep 2026), primary
- AWS – Bedrock Claude India geo inference, https://aws.amazon.com/about-aws/whats-new/2026/09/claude-region-expansion-in-sk/ (Sep 2026), primary
- AWS – Bedrock OpenAI models in India, https://aws.amazon.com/about-aws/whats-new/2026/08/amazon-bedrock-openai-india-v1/ (Aug 2026), primary
- AWS Regional product availability (via AWS Knowledge MCP), https://aws.amazon.com/about-aws/global-infrastructure/regional-product-services/ (accessed 2026-10-10), primary
- microsoft/typescript-go README, https://github.com/microsoft/typescript-go (accessed 2026-10-10), primary
- typescript-eslint v8.65.0 release, https://github.com/typescript-eslint/typescript-eslint/releases/tag/v8.65.0 (2026-07-20), primary
- npm registry metadata (typescript-eslint, typescript, next, expo, fastify, kysely, drizzle-orm, prisma, pg-boss, graphile-worker, bullmq, temporal, inngest, trigger.dev, restate, turbo, nx, pnpm, zod), https://registry.npmjs.org (accessed 2026-10-10), primary
- pg-boss README, https://github.com/timgit/pg-boss (accessed 2026-10-10), primary
- fastify-swagger README, https://github.com/fastify/fastify-swagger (accessed 2026-10-10), primary
- Temporal Cloud AWS/GCP regions, https://github.com/temporalio/documentation/tree/main/docs/cloud/references/regions (accessed 2026-10-10), primary
- Inngest README (licence, self-hosting), https://github.com/inngest/inngest (accessed 2026-10-10), primary
- Trigger.dev README, https://github.com/triggerdotdev/trigger.dev (accessed 2026-10-10), primary
- Restate LICENSE (BSL 1.1), https://github.com/restatedev/restate (accessed 2026-10-10), primary
- Sentry – Data Storage Location, https://github.com/getsentry/sentry-docs/blob/master/docs/organization/data-storage-location/index.mdx (accessed 2026-10-10), primary
- Apache Fineract README and releases, https://github.com/apache/fineract (accessed 2026-10-10), primary
- OpenTofu releases, https://github.com/opentofu/opentofu/releases (accessed 2026-10-10), primary
- RBI – Reserve Bank of India (Digital Lending) Directions, 2025, https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12848 (8 May 2025), primary (blocked; not fetched)
- S.S. Rana – RBI introduced Digital Lending Direction, 2025, https://ssrana.in/articles/rbi-introduced-digital-lending-direction-2025/ (2025), secondary
- Mondaq – Digital lending regulatory reset, https://www.mondaq.com/india/financial-services/1632398/digital-lending-in-india-a-regulatory-reset-under-the-reserve-bank-of-india-digital-lending-directions-2025 (2025), secondary
- Vinod Kothari – The Great Consolidation, https://vinodkothari.com/2025/10/the-great-consolidation/ (Oct 2025), secondary
- CERT-In Directions under s.70B(6), 28 Apr 2022, and FAQs, https://www.cert-in.org.in (2022), primary (blocked; from prior knowledge, marked likely)
