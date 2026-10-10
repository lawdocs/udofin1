# ADR-0010: Hosting and data residency

- **Status:** Proposed — production hosting is not built; the AWS account and its cost/operations owner are open owner decisions
- **Date:** 2026-10-10
- **Related:** ADR-0004, ADR-0009, ADR-0011, ADR-0019

## Context

Research findings (`docs/research/2026-10-10/infra-stack.md`, `rbi-digital-lending.md` DL-15, `privacy-security-outsourcing.md` §6):

- Reported RBI rule: borrower data must be stored only on servers in India; data processed abroad must be deleted there and brought back within 24 hours. Status: confirmed (secondary) in `rbi-digital-lending.md`; likely in `infra-stack.md`; whether it covers operational logs and IP addresses is an open legal question.
- CERT-In Directions of 28 Apr 2022: incident reporting within 6 hours; ICT logs kept for a rolling 180 days within Indian jurisdiction; clock sync. Status: likely.
- **Supabase:** project `Udofin-app` is in ap-south-1 (Mumbai), Postgres 17.6 (confirmed). Data stays in the chosen region except read replicas, whose region is the customer's responsibility (confirmed). The region of backup/PITR storage and of platform logs is **not documented** (unverified). Smart CDN caches signed-URL responses at global edges and does not purge them when the token expires (confirmed). Edge Functions run in the region nearest the caller unless pinned (confirmed). Supabase lists only ap-south-1 in India, so no in-India DR on Supabase (likely).
- **Railway:** four regions only — US West (California), US East (Virginia), EU West (Amsterdam), Southeast Asia (Singapore); no bring-your-own-cloud; logs kept 30 days (Pro) to 90 days (Enterprise), storage location undocumented (confirmed; location unverified). `railway.json` / `railway.toml` stop being read on 2026-12-01; replacement is `.railway/railway.ts` (confirmed).
- **AWS:** App Runner closed to new customers effective 30 Apr 2026; ECS Express Mode is its successor (confirmed). Fargate, KMS, Secrets Manager, CloudWatch, SQS and others exist in ap-south-1 and ap-south-2 (confirmed); Amazon Managed Grafana is not expanding to either Indian region (confirmed).
- **Observability SaaS:** Sentry SaaS stores event data only in the US or EU, some metadata always in the US (confirmed). Datadog sites listed by Supabase include none in India (confirmed list).
- **Finbyx**, a sister product, runs in a Supabase project in ap-northeast-1 (Tokyo) (confirmed via Management API).

## Decision

1. **Database and auth:** Supabase in ap-south-1. Obtain Supabase's **written confirmation** of where backups/PITR and platform logs are stored. Read replicas, if any, only in ap-south-1.
2. **Railway only for development and staging, with synthetic data only.** No borrower data, no volumes or buckets holding real data, ever.
3. **Production on AWS ap-south-1 (Mumbai) before the first real borrower:** compute (API, workers, portals) on ECS with Fargate; object storage on S3 with SSE-KMS, Block Public Access and Object Lock for audit/log archives; keys in KMS; secrets in Secrets Manager; logs in CloudWatch or a self-hosted Grafana stack in ap-south-1. Disaster recovery in ap-south-2 (Hyderabad) later.
4. **Files:** Supabase Storage is **not** used for KYC or loan documents. Documents go to S3 Mumbai and are served by short-lived presigned URLs issued by the API after authorisation, with no CDN in the path.
5. **Edge Functions**, if used, are pinned to ap-south-1; prefer Postgres functions or hooks.
6. **Observability:** OpenTelemetry to a collector in ap-south-1 and an India-hosted backend. No Sentry SaaS (or other offshore SaaS) for anything that may carry personal data. Security and access logs kept at least 180 days in India.
7. **Push notifications** carry no personal data (generic text; details fetched in-app), because push services route outside India (research interpretation).
8. **Build artefacts:** the baseline is to ship a Dockerfile only (no `railway.json`/`railway.toml`). Any Railway configuration goes in `.railway/railway.ts`. Infrastructure as code later with OpenTofu or Terraform, with a region allowlist of ap-south-1 and ap-south-2.
9. **Finbyx:** recreate its project in Mumbai, migrate, rotate keys, delete the Tokyo project. If it ever held real data, treat it as an incident with an inventory of what was held.

## Alternatives considered

| Option                                                                                                 | Why rejected                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Railway for production                                                                                 | No India region or BYOC; offshore logs and any state; Singapore egress IPs (research).                                    |
| Railway as a short, stateless production bridge with PII-free logs and the lender's written acceptance | Research lists it as a fallback, not a default. It would force a second round of lender IT audits at cut-over.            |
| AWS App Runner                                                                                         | Closed to new customers (confirmed).                                                                                      |
| EKS / Kubernetes                                                                                       | Control-plane and operating burden not justified now (research interpretation).                                           |
| Move the database to Aurora now                                                                        | Also replaces Supabase Auth. Deferred; a candidate if in-India DR becomes mandatory.                                      |
| Other clouds' Indian regions                                                                           | Not evaluated in the research; AWS chosen for KMS, S3 Object Lock and Bedrock India inference coverage found in research. |

## Consequences

**Positive**

- Every store that may hold borrower data is in India, with a documented inventory for lender due diligence.
- One lender IT audit of the production setup, instead of a second audit after a migration.

**Negative**

- Two providers in production (Supabase and AWS): cross-provider networking (Supabase PrivateLink is beta; otherwise network restrictions and static NAT IPs), two bills, two sets of access controls.
- AWS operations skills and cost are needed before launch; the owner must name a cost and operations owner.
- Staging in Singapore does not reproduce production latency (Singapore–Mumbai round trips, unverified estimate 55–70 ms).

**Risks**

- Backups or Supabase platform logs may sit outside India until confirmed in writing.
- No in-India DR for the database while on Supabase.

## Compliance and security notes

- Supports the reported India-storage rule and CERT-In log retention (labels above). Evidence (planned): infrastructure region inventory, vendor residency attestations, retention settings.
- Primary-source verification gate applies (README).

## Verification

- Planned (research INF-01): a CI job that lists Supabase projects and AWS resources and fails if any production resource is outside the allowlist. Today it would fail on the Finbyx project.
- Planned: an expired presigned URL returns 4xx with no cache hit (INF-08); Edge Function responses show the ap-south-1 region (INF-09); a log-injection test proves test PAN/Aadhaar/mobile values do not appear in logs (INF-02); quarterly restore drill.

## Revisit triggers

- Railway adds an India region or BYOC; Supabase adds a second Indian region.
- Supabase's written answer on backup and log location.
- Primary-text review of the 24-hour rule and its scope.
- A partner lender requires a different setup (for example its own cloud account).
