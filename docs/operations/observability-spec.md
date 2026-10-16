# Observability specification (traces, metrics, logs, alerts)

|          |                                                                                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status   | **Specification only. Not implemented.** Nothing in this document runs today: no collector, no metrics, no traces, no alert rules, no on-call rota. Every threshold below is a proposal for the owner to confirm and then tune against real traffic. |
| Decision | ADR 0010 point 6 (Proposed): OpenTelemetry to a collector in ap-south-1 and an India-hosted backend; no offshore SaaS for anything that may carry personal data; security and access logs kept at least 180 days in India.                           |
| Origin   | Architecture verification, `docs/architecture/phase-02-architecture-verification.md`, decision register item R: "Blind in production. Specify OpenTelemetry to an India backend."                                                                    |
| Related  | [`runbook-outbox.md`](runbook-outbox.md), [`document-store-production-spec.md`](document-store-production-spec.md), `docs/data/ownership.md` (log retention), `docs/security/threat-model.md`                                                        |

## 1. What exists today

Stated so that nobody mistakes the target for the current state:

- The API and the lender callback receiver write structured JSON logs (pino) to standard output (`services/api/src/logger.ts`). The worker writes its own JSON lines to standard output (`services/api/src/workers/main.ts`) **without** the redaction layer; it relies on logging only event ids, types and error codes. Before real data, route the worker through the same redacting logger.
  Credentials, one-time codes, PAN, Aadhaar, phone, e-mail, account numbers, addresses and names are redacted by key at any depth
  (a safety net, not the policy: code should not log payloads). Request logs carry method and path (no query string), request id,
  status, duration and the **remote IP address**.
- Request ids are validated or generated (`services/api/src/app.ts`); problem responses carry the id.
- `/health/live` and `/health/ready` exist (dependency names only).
- 5xx responses never leak internals. The outbox worker logs the event id, type and error code, never a payload.
- Nothing else. Logs stay wherever the platform puts standard output; a deployed environment does not exist yet.

## 2. Rules the design must keep

| Rule                                                                                                                                                                                  | Source                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| No PAN, Aadhaar, OTP, phone number, account number or name in logs, URLs, events, push payloads or error messages. The same applies to span attributes, metric labels and alert text. | `CLAUDE.md` rule 3                                             |
| Anything that stores or logs borrower data runs in India. Telemetry for production goes to ap-south-1 only.                                                                           | `CLAUDE.md` rule 7, ADR 0010                                   |
| No Sentry SaaS, Datadog SaaS or other offshore service for telemetry that may carry personal data. A pager or chat tool may receive alert titles only.                                | ADR 0010 (Sentry and Datadog residency: confirmed in research) |
| Security and access logs are kept for a rolling 180 days or more in India (CERT-In Directions, 28 April 2022). Status: **likely**, primary text not verified.                         | ADR 0010, `docs/data/ownership.md` section 7                   |
| Railway (staging) retains logs outside India and in an undocumented place. Staging holds synthetic data only and must still never log personal data.                                  | ADR 0010                                                       |
| Telemetry is itself confidential data: staff-only, strong authentication, access is audited.                                                                                          | design rule (this document)                                    |

## 3. Architecture (target)

```
API, worker, callback receiver (OpenTelemetry SDK, Node)
        │  OTLP over TLS, inside the production network
        ▼
OpenTelemetry Collector (ap-south-1)  ── processors: attribute allow-list and PII drop, sampling, batching
        ├──► metrics store ─► dashboards, alert rules ─► pager (alert titles only)
        ├──► trace store
        └──► log store ─► 180-day tier; WORM archive (S3 Object Lock) for security logs
```

- **Backend: owner decision.** Either CloudWatch in ap-south-1 or a self-hosted Grafana stack (Loki, Tempo, Mimir) on the
  same AWS account. Both are allowed by ADR 0010. Amazon Managed Grafana is not available in the Indian regions (confirmed in
  ADR 0010 research), so Grafana would be self-hosted. Compare cost and operating effort before choosing; record the choice in an ADR.
- **Two lines of defence against personal data.** (1) The application never puts it in telemetry (existing redaction plus review).
  (2) The collector drops any attribute not on an allow-list and any value matching a PAN, Aadhaar, phone or e-mail shape. The collector rule
  is tested with canary values (section 9).
- **Resource attributes** on every signal: `service.name` (`udofin-api`, `udofin-worker`, `udofin-callbacks`), `deployment.environment`
  (`APP_ENV`), `service.version` (image digest or git sha). No tenant name.
- **Correlation.** The request id and the W3C trace id appear in the log line, the span and the problem response. A worker span for an
  outbox event links to the span of the request that wrote the event through `correlation_id`.
- **What is never captured:** request or response bodies, headers other than a short allow-list, query strings, SQL text and bound
  parameters (disable statement capture in the database instrumentation; record the operation name and the function called), tokens,
  document bytes, and the contact reveal result.
- **Identifiers.** Telemetry may carry the lender organisation id (a tenant id, not personal data) as a **log and trace** attribute for
  support, never as a metric label (cardinality). A borrower or staff user id is not attached to spans or metrics; if an investigation needs it,
  it is found through the request id and the audit trail.
- **Failure of telemetry must not fail a request.** Export is asynchronous with a bounded queue; when it is full the SDK drops data and a
  counter records the drop.

## 4. Logs

| Aspect               | Specification                                                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format               | One JSON object per line (as today) plus `trace_id` and `span_id`.                                                                                                                                                                                                                  |
| Levels               | `info` in staging and production; `debug` only on request and never in production; `trace` is refused in production (already enforced by configuration validation); staging is not yet covered by that rule.                                                                        |
| Required fields      | `time`, `level`, `service`, `env`, `msg`, `req.id`, `req.method`, `req.path` (route template, not the raw path with ids, where available), `res.statusCode`, `responseTime`, `trace_id`.                                                                                            |
| Security events      | Authentication failures, rejected signatures (SMS hook, lender callbacks), rate-limit rejections, permission denials, document retrievals, replayed outbox events, step-up failures: each a log line with a stable `event` name and **reason class only**.                          |
| Client IP address    | Request logs carry the remote IP today. An IP address is personal data (open legal point, see `docs/data/ownership.md` section 5.4). **Owner and counsel decision:** keep it in security logs for abuse investigation; for ordinary request logs consider truncating or hashing it. |
| Retention (proposal) | Security and access logs: at least 180 days hot or warm in India, then a write-once archive if the owner wants one (Object Lock, S3). Ordinary request and debug logs: as short as operations allow (proposal 30 days). Not decided; see section 10.                                |
| Time                 | UTC timestamps, synchronised clocks (CERT-In asks for clock synchronisation: likely).                                                                                                                                                                                               |
| Injection            | Request ids are validated before they reach logs (an existing API test covers this). A test that canary personal data never appears in log output is planned (research test INF-02, ADR 0010).                                                                                      |

## 5. Traces

- Server spans for every HTTP request (route template, method, status class). Child spans for: token verification (JWKS cache hit or fetch),
  the database transaction (`withUserContext`) and each call to a Postgres function (span name = function name, no parameters),
  provider calls (SMS, device integrity, lender connector, signing, document store) and the outbox handler run.
- Sampling: keep all error spans and all spans slower than 1 second; sample the rest (proposal: 10% in production, 100% in staging).
- Retention: 14 days (proposal). Traces carry no personal data, so this is an operations choice, not a legal one.

## 6. Metrics

Names follow OpenTelemetry semantic conventions where one exists (`http.server.*`, `db.client.*`) and `udofin.*` otherwise.
Labels are low-cardinality: route **template**, status class, outcome, a fixed reason enum. Never a user, tenant, lender, application, phone or IP label.

### 6.1 API

| Metric                                                       | Type             | Labels                                                                                            | Purpose                                                                                                            |
| ------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `http.server.request.duration` (seconds)                     | histogram        | route, method, status class                                                                       | Latency and error rate per route                                                                                   |
| `http.server.active_requests`                                | gauge            | -                                                                                                 | Saturation                                                                                                         |
| `udofin.http.rate_limited`                                   | counter          | route group, limiter (`ip`, `principal`)                                                          | Rate-limit rejections (429)                                                                                        |
| `udofin.auth.failures`                                       | counter          | surface (`api`, `portal_bff`), reason enum                                                        | Missing, invalid or expired token; session revoked; wrong portal; MFA required; staff check failed; sign-in failed |
| `udofin.authz.denied`                                        | counter          | surface, source (`api`, `database`)                                                               | Permission checks that refused (database `42501` from user context counts here)                                    |
| `udofin.idempotency.replays`, `udofin.idempotency.conflicts` | counter          | route group                                                                                       | Replayed and key-reuse (`422`) requests                                                                            |
| `udofin.sms_hook.requests`                                   | counter          | outcome (`accepted`, `rejected`, `timeout`, `signature_invalid`, `replay`)                        | Send-SMS hook health                                                                                               |
| `udofin.callbacks.received`                                  | counter          | outcome (`applied`, `duplicate`, `signature_invalid`, `rejected`, `unavailable`)                  | Lender callback receiver (aggregate across lenders; no lender label)                                               |
| `udofin.lender.submit`                                       | counter          | outcome (`accepted`, `rejected`, `unknown`, `not_configured`)                                     | Uncertain sends need reconciliation (ADR 0030)                                                                     |
| `udofin.documents.retrievals`                                | counter          | document type, outcome (`served`, `denied`, `not_found`, `integrity_failed`, `store_unavailable`) | Document retrievals (section 6.4)                                                                                  |
| `db.client.connection.count`, `udofin.db.pool.wait`          | gauge, histogram | pool (`user`, `system`), state                                                                    | Connection pool saturation                                                                                         |
| `udofin.db.errors`                                           | counter          | SQLSTATE class                                                                                    | Spikes of `42501` (permission) or `40001`/`40P01` (serialisation, deadlock)                                        |
| `udofin.health.ready`                                        | gauge            | dependency name                                                                                   | 1 healthy, 0 not                                                                                                   |

### 6.2 Worker and outbox

| Metric                                       | Type      | Labels                                                           | Source                                                  |
| -------------------------------------------- | --------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| `udofin.outbox.events`                       | gauge     | status (`pending`, `processing`, `completed`, `dead`)            | `ops.outbox_health()` `byStatus`                        |
| `udofin.outbox.oldest_pending_age` (seconds) | gauge     | -                                                                | `oldestPendingAgeSeconds`                               |
| `udofin.outbox.dead_events`                  | gauge     | -                                                                | `deadCount`                                             |
| `udofin.outbox.oldest_dead_age` (seconds)    | gauge     | -                                                                | `oldestDeadAgeSeconds`                                  |
| `udofin.outbox.expired_leases`               | gauge     | -                                                                | `expiredLeases`                                         |
| `udofin.outbox.handler.duration` (seconds)   | histogram | event type, outcome                                              | Handler run                                             |
| `udofin.outbox.handler.outcomes`             | counter   | event type, outcome (`completed`, `retry`, `dead`, `lease_lost`) | Handler results                                         |
| `udofin.worker.heartbeat`                    | gauge     | worker                                                           | Unix time of the last poll; a stopped worker goes stale |
| `udofin.worker.purged`                       | counter   | kind (`idempotency`, `completed_events`)                         | Housekeeping ran                                        |

`ops.outbox_health()` is **added in the remediation migration** (`20261017000905_remediation_db.sql`). The worker (or a scheduled job) calls it
about once a minute and publishes the gauges.

### 6.3 Platform

Taken from the platform if it exposes them; **whether Supabase and AWS expose these, and where, is unverified** and must be confirmed
before this section is relied on: database CPU, memory, disk and connection count, replication or backup lag, last successful backup
time, certificate expiry, container restarts and out-of-memory kills, load balancer 5xx and target health.

### 6.4 Document retrievals

Every retrieval is already recorded in the database (`documents.access_log`, with the reason and the actor). The metric exists for
operations, not for evidence: a rise in `denied`, any `integrity_failed` (stored hash differs from the bytes) and `store_unavailable`
are operational signals. No document id, lender or file name is a label.

## 7. Alerts

Severity: **Page** wakes the on-call person. **Ticket** is looked at the same working day. All values are proposals; none is wired.
Alert text states the condition and the runbook link, never an identifier or personal data.

| Alert                                                 | Condition (proposal)                                                                             | Severity      | Response                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------- |
| API errors                                            | 5xx ratio above 2% for 5 minutes (above 5% for 5 minutes pages)                                  | Ticket / Page | Check recent deploy, dependencies, database                                     |
| API latency                                           | p95 above 1.5 s for 10 minutes on any route                                                      | Ticket        | Check database, provider timeouts                                               |
| Readiness                                             | `udofin.health.ready` is 0 for any dependency for 2 minutes                                      | Page          | Dependency down                                                                 |
| No telemetry                                          | No metrics or logs from a service for 5 minutes                                                  | Page          | The service or the pipeline is down                                             |
| Worker stopped                                        | `udofin.worker.heartbeat` older than 3 minutes                                                   | Page          | [`runbook-outbox.md`](runbook-outbox.md) section 5.2                            |
| Outbox: dead events                                   | `udofin.outbox.dead_events` above 0 (ticket); oldest dead age above 1 hour (page)                | Ticket / Page | [`runbook-outbox.md`](runbook-outbox.md) section 5.1                            |
| Outbox: lag                                           | Oldest ready pending event above 5 minutes (ticket) or 15 minutes (page)                         | Ticket / Page | Runbook section 5.2                                                             |
| Outbox: expired leases                                | Above 0 on two readings in a row                                                                 | Ticket        | Runbook section 5.3                                                             |
| Authentication failures                               | `udofin.auth.failures` more than 5 times the 7-day hourly median and above 100 per 5 minutes     | Ticket        | Possible credential stuffing or a broken client                                 |
| Session or sign-out anomalies                         | Spike in `session revoked` or `wrong portal` reasons above 3 times baseline                      | Ticket        | Investigate with the audit trail                                                |
| Rate-limit rejections                                 | `udofin.http.rate_limited` above 50 per minute for 10 minutes                                    | Ticket        | Abuse, or a mis-set proxy-hop count putting everyone in one bucket (audit R-02) |
| Rate limiter bucket concentration                     | One limiter bucket serving more than 50% of rejections                                           | Ticket        | Same                                                                            |
| Permission denials from the database                  | `udofin.db.errors` class `42` code `42501` from user context above 3 times baseline              | Ticket        | A bug, or probing                                                               |
| Document integrity                                    | Any `udofin.documents.retrievals{outcome="integrity_failed"}`                                    | Page          | Treat as possible tampering or storage corruption                               |
| Document store unavailable                            | `store_unavailable` above 0 for 5 minutes                                                        | Page          | Object storage or key service problem                                           |
| Document retrieval denials                            | `denied` above 3 times baseline for an hour                                                      | Ticket        | Misconfiguration or probing                                                     |
| SMS hook                                              | `timeout` + `rejected` above 5% of requests over 10 minutes, or any burst of `signature_invalid` | Ticket        | Provider outage or someone calling the hook                                     |
| Lender callbacks                                      | `signature_invalid` above 0 sustained for 10 minutes                                             | Ticket        | Wrong secret, or an attacker                                                    |
| Uncertain lender sends                                | `udofin.lender.submit{outcome="unknown"}` above 5 in 30 minutes                                  | Ticket        | Reconcile through the connector lookup, do not resend                           |
| Database saturation                                   | Pool wait p95 above 200 ms for 5 minutes, or platform connection use above 80%                   | Ticket        | Pool sizing, slow queries                                                       |
| Backups (needs platform data, section 6.3)            | Last successful backup older than 26 hours                                                       | Page          | Backup failure                                                                  |
| Audit chain (once the anchoring job exists, ADR 0013) | `private.audit_digest()` differs from the latest anchor                                          | Page          | Possible tampering                                                              |
| Certificate expiry                                    | Less than 21 days                                                                                | Ticket        | Renew                                                                           |

## 8. Dashboards (minimum)

1. Service health: request rate, 5xx ratio, p50 and p95 latency, readiness, restarts.
2. Outbox: counts by status, oldest pending and dead age, expired leases, handler outcomes.
3. Security: authentication failures by reason, rate-limit rejections, permission denials, signature failures, document denials and integrity failures.
4. Integrations: SMS hook outcomes, lender submit outcomes, callbacks received, provider latency.
5. Platform: database, containers, storage and backup status (when exposed).

## 9. Test plan (when implemented)

| Test                                                                                                                                                                        | Proves                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Send requests containing canary PAN, Aadhaar, phone, e-mail and account-number values in bodies, query strings, headers and error paths; scan the collector output for them | No personal data reaches logs, spans or metrics                |
| Send a canary value as a span attribute through a test span                                                                                                                 | The collector's allow-list and PII drop are effective          |
| Forge a request id containing a newline and JSON                                                                                                                            | Log injection is impossible                                    |
| Inventory of collector, store and archive resources                                                                                                                         | Everything is in ap-south-1 (the region allowlist, ADR 0010)   |
| Kill the collector                                                                                                                                                          | Requests still succeed; the drop counter increases             |
| Stop the worker; create a dead event; fill a lease                                                                                                                          | Each outbox alert fires and links to the right runbook section |
| Alert fire drill each quarter with the on-call person                                                                                                                       | The path from alert to a person works                          |

## 10. Open decisions for the owner

| Decision                                                                                  | Notes                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Telemetry backend: CloudWatch or a self-hosted Grafana stack, both in ap-south-1          | Cost, operating effort, who maintains it                                                                                       |
| Retention of ordinary request logs and whether the client IP is truncated or hashed there | Counsel: is an IP address personal data under the DPDP Act for this purpose (likely yes); CERT-In applies to ICT logs (likely) |
| Who is on call, and the pager or chat tool                                                | Any offshore tool receives alert titles only                                                                                   |
| Whether a write-once archive is needed for security logs                                  | Recommended by research (1 year hot plus 2 years archive) [recommendation]                                                     |
| Supabase's written confirmation of where platform logs and backups are kept               | Outstanding (ADR 0010, `docs/data/ownership.md`)                                                                               |
| Thresholds in section 7                                                                   | Tune after the first weeks of staging traffic                                                                                  |

## 11. Out of scope

Product analytics, session replay, A/B tools and any third-party script in the portals or the app (ADR 0017 forbids them); application
performance monitoring that ships data outside India; an error-reporting SaaS for server code.
