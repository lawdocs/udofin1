# ADR-0011: Background jobs — transactional outbox and pg-boss

- **Status:** Proposed — not yet implemented
- **Date:** 2026-10-10
- **Related:** ADR-0003, ADR-0004, ADR-0010, ADR-0012

## Context

- Many steps must happen after a database change and must survive crashes and retries: notifications, calls to lenders' bureau and KYC rails, document generation, LMS sync, outbound webhooks, provider-event processing, reminders.
- A job must not be lost if the transaction commits, and must not run if the transaction rolls back. Writing to a second system (for example Redis) after commit cannot guarantee both.
- Job payloads may reference borrower data, so the queue is a data store subject to residency (ADR-0010).
- Research (`docs/research/2026-10-10/infra-stack.md` §6):
  - pg-boss: MIT; jobs created inside the existing database transaction, with adapters including Kysely; dead-letter queues with redrive, retries with backoff, cron; needs Node ≥ 22.12; single maintainer (confirmed).
  - Graphile Worker: MIT; `add_job()` in SQL so enqueue is transactional; LISTEN/NOTIFY design needs a session or direct connection (versions/licence confirmed; design likely).
  - BullMQ + Redis: a second stateful store with no atomic enqueue alongside Postgres; Redis on Railway would sit in Singapore.
  - Temporal: best fit for long sagas; Temporal Cloud has aws-ap-south-1, aws-ap-south-2 and gcp-asia-south1 regions (confirmed).
  - Inngest (server SSPL plus delayed Apache-2.0) and Trigger.dev are cloud-first; Restate's server is BSL 1.1 (licences confirmed).

## Decision

1. **Transactional outbox:** every domain change that needs follow-up work writes an outbox row (a CloudEvents envelope from `packages/contracts`, ADR-0012) in the **same** Postgres transaction as the change.
2. **pg-boss** runs jobs from a worker entrypoint of the modular monolith (ADR-0003). Jobs are enqueued inside the same transaction (through the Kysely adapter) or by a relay that drains the outbox.
3. **Idempotent handlers:** at-least-once delivery is assumed. Handlers de-duplicate on the event's `(source, id)` or `(aggregate_id, event_id)`. Every external call that creates or moves something carries an idempotency key (`ProviderCallContext.idempotencyKey` in `packages/adapters/src/provider.ts`).
4. **Least data in payloads:** job and outbox payloads carry identifiers and a `dataclassification` label, not identity numbers or documents; handlers load what they need under the right lender scope.
5. **System identity:** workers use `service_role` only in worker code paths; every system action that changes state is audited (ADR-0013).
6. **Escalation path:** adopt Temporal (Cloud in Mumbai/Hyderabad, or self-hosted in ap-south-1) only when multi-step flows (application → offers → eSign → disbursement → mandate; collections) become hard to reason about as chained jobs and state machines.
7. **Not used:** Redis/BullMQ, hosted Inngest or Trigger.dev, Restate.

## Alternatives considered

| Option                       | Why rejected                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graphile Worker              | Strong runner-up with transactional enqueue in SQL. pg-boss preferred for its Kysely adapter, DLQ/redrive and cron in one package (research). Its LISTEN/NOTIFY design also needs session or direct connections. |
| BullMQ + Redis               | No atomic enqueue with the domain write; another stateful store; residency concern if hosted on Railway.                                                                                                         |
| Temporal from day one        | More infrastructure and concepts than the first flows need; kept as the escalation path.                                                                                                                         |
| Hosted Inngest / Trigger.dev | Cloud-first; event payloads would leave India (research).                                                                                                                                                        |
| Restate                      | Young; BSL 1.1 server licence (confirmed).                                                                                                                                                                       |
| AWS SQS / EventBridge only   | Available in ap-south-1, but enqueue is not atomic with the Postgres write unless fed from the outbox; adds a second system. May be used later as a delivery channel behind the outbox.                          |

## Consequences

**Positive**

- No lost or phantom jobs: the job exists if and only if the business change committed.
- One data store to secure, back up and keep in India.
- Retries, dead letters and schedules without new infrastructure.

**Negative**

- Queue tables add write and vacuum load to the operational database.
- At-least-once delivery means every handler must be idempotent; this is a coding discipline that needs tests.
- Single-maintainer dependency (research).

**Risks**

- A slow or stuck queue delays borrower-visible steps (OTP, offers). Mitigation (planned): queue-depth and age alerts.
- Payloads accidentally carrying personal data would spread it into queue tables and logs. Mitigation: classification label and payload review.

## Compliance and security notes

- Keeping jobs in the Mumbai database supports the reported India-storage rule (ADR-0010; research labels there).
- Idempotency keys on external calls protect against duplicate disbursement or debit instructions; they do not replace the lender-side controls.
- Primary-source verification gate applies to the residency rule (README).

## Verification

Planned tests when implemented:

- A rolled-back transaction leaves no outbox row and no job.
- Delivering the same event twice produces one effect.
- A failing job retries with backoff, then lands in the dead-letter queue and can be redriven.
- A payload containing a field classed as restricted is rejected.

## Revisit triggers

- Sagas spanning lenders, eSign, disbursement and mandates become hard to follow or test as chained jobs (consider Temporal).
- Queue volume degrades database performance.
- pg-boss maintenance stalls.
- The database moves off Supabase (ADR-0004).
