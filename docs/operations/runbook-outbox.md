# Runbook: inspecting and recovering the outbox

|         |                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status  | **Procedure written; nothing is deployed and no alert exists.** The two database functions it relies on were **added in the remediation migration** `supabase/migrations/20261017000905_remediation_db.sql` (14 October 2026) and have only been run on local and CI databases. |
| Origin  | Architecture verification, `docs/architecture/phase-02-architecture-verification.md` item J: "dead-event replay and an alert runbook before staging".                                                                                                                           |
| Related | [`../api/idempotency-and-outbox.md`](../api/idempotency-and-outbox.md) (how the outbox works), ADR 0011 as amended, [`observability-spec.md`](observability-spec.md) (alerts), ADR 0030 (uncertain sends).                                                                      |

## 1. What can go wrong

Work that must happen after a database change (send a code, hand an application to a lender, generate a document,
apply an approved change) is written to `ops.outbox_events` in the **same transaction** as the change. A worker
(`pnpm --filter @udofin/api worker`) claims events, runs the handler, then marks them complete.

Delivery is **at least once**. Ordering is **not** guaranteed and handlers must not assume it. There is no
exactly-once claim anywhere in this system.

| State        | Meaning                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pending`    | Waiting for `available_at`. A retry after a failure is `pending` with a later `available_at` (5 s, doubling, capped at 1 hour, with up to 20% jitter). |
| `processing` | A worker holds a 60-second lease (`locked_until`). If the worker dies the lease expires and another worker takes the event over.                       |
| `completed`  | Done. Purged by the worker after 30 days.                                                                                                              |
| `dead`       | Gave up: a permanent error, an invalid payload, or 8 attempts used. **Nothing will run it again until a person decides.** This is the alert state.     |

A silent failure looks like one of three things: dead events nobody noticed, a worker that is not running (events wait
for ever), or a worker that is stuck (leases keep expiring).

## 2. Who may do this

- Engineers on the on-call list, through the **system login** (`udofin_system`), which can only assume `service_role`.
  The functions below refuse any other role (`42501 system only`). There is no portal screen and no API route for this
  today: it is SQL, run deliberately.
- Use a session that is logged (a bastion or the managed SQL console with audit), never a shared account. The
  operator name you pass to `requeue_dead_event` is written to the audit trail, so use your own stable identifier.
- Event payloads are references (ids), not personal data, but treat them as confidential: do not paste a payload into a
  ticket, chat or log. The queries below deliberately do not select it.
- Never edit `ops.outbox_events` by hand (`update ... set status = 'pending'`). That skips the audit record and the
  checks below.

## 3. Inspect

Connect with the system login and assume the system role for the transaction:

```sql
begin;
set local role service_role;
select ops.outbox_health();
```

`ops.outbox_health()` (added in the remediation migration) returns one JSON object with no payloads and no
identifiers:

| Field                     | Meaning                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `byStatus`                | Counts of `pending`, `processing`, `completed`, `dead`                                                                  |
| `oldestPendingAgeSeconds` | Age of the oldest event that is **ready to run** (a retry still waiting for its backoff is not counted); `null` if none |
| `deadCount`               | Number of dead events                                                                                                   |
| `oldestDeadAgeSeconds`    | Age of the longest-dead event; `null` if none                                                                           |
| `expiredLeases`           | Events still `processing` whose lease has run out (a worker died or hung)                                               |
| `checkedAt`               | Server time of the reading                                                                                              |

List the dead events (no payload):

```sql
select id, event_type, attempts, max_attempts, last_error_code, correlation_id, created_at, updated_at
from ops.outbox_events
where status = 'dead'
order by updated_at;
```

`last_error_code` is a short code (`handler_error`, `invalid_payload`, ...), never free text. The worker log carries
the same event id, type and code, plus the request or correlation id, and no payload.

## 4. Alert thresholds

**Proposed starting values for the owner to confirm, tune against real traffic, and wire into the alerting system
described in [`observability-spec.md`](observability-spec.md). None of this is configured.** The readings come from
`ops.outbox_health()`, polled by the worker or a scheduled job once a minute.

| Condition                                                           | Severity         | Why                                                                                |
| ------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `deadCount` > 0                                                     | Warning (ticket) | Business follow-up work has failed for good. Look the same working day.            |
| `oldestDeadAgeSeconds` > 3600                                       | Page             | A dead event has been ignored for an hour.                                         |
| `oldestPendingAgeSeconds` > 300                                     | Warning          | Ready work is waiting: the worker is slow, down or starved.                        |
| `oldestPendingAgeSeconds` > 900                                     | Page             | Borrower-visible steps (codes, lender hand-off) are delayed.                       |
| `expiredLeases` > 0 on two consecutive readings (about 2 min)       | Warning          | The lease is 60 s; a lease that stays expired means a worker crashed or is stuck.  |
| `byStatus.pending` growing for 30 minutes while `completed` is flat | Warning          | Throughput problem, not just a slow event.                                         |
| No reading for 5 minutes                                            | Page             | The monitor itself is down. A silent outbox looks the same as a healthy empty one. |

## 5. Respond

### 5.1 A dead event

1. Read `last_error_code`, `event_type`, `attempts` and `correlation_id` from the list above and the worker log for
   that id. Find out **why** it stopped, in this order:
   - `invalid_payload`: the producer wrote something the handler's schema refuses, or a rolling deploy mixed
     versions. The event will never succeed unchanged. Fix the producer or handler first.
   - `handler_error` or a permanent provider error: a dependency refused it. Fix or restore the dependency.
   - Attempts exhausted on a transient fault (an outage): the cause may already be gone.
2. **Decide whether replay is safe.** Handlers are written to be idempotent, but a handler that talks to an outside
   party (a lender, an SMS provider, a signing provider) may already have succeeded before the failure was recorded.
   For those, check the other side first. An uncertain send is **reconciled through the connector's lookup**, never
   blindly resent (ADR 0030, decision 4). If the work no longer makes sense (the consent was withdrawn, the offer expired),
   do not replay; record why and leave the event dead.
3. **Replay** once the cause is fixed:

   ```sql
   begin;
   set local role service_role;
   select ops.requeue_dead_event('<event-uuid>', '<your-operator-id>');   -- true: requeued; false: not dead, nothing done
   commit;
   ```

   `ops.requeue_dead_event(p_id uuid, p_actor text)` (added in the remediation migration) moves a **dead** event
   back to `pending` with zero attempts and runs it as soon as a worker is free. The operator identifier is 1 to 80
   characters of letters, digits and `. _ : -` (no e-mail address). The call writes an `ops.outbox.requeued` record to
   `audit.events` with the operator, the event type, the previous attempts and error code, and **no payload**.
   `last_error_code` is kept on the row until the event next succeeds, so the earlier cause stays visible.
   The older one-argument form `ops.requeue_dead_event(p_id uuid)` still exists, now records the operator as
   `unspecified`, and should not be used.

4. Watch it: the event should reach `completed` within a minute or two. If it goes dead again, stop and escalate; do not loop.
5. Record the incident: event ids, cause, decision, and who replayed.

### 5.2 Events waiting for ever (`oldestPendingAgeSeconds` growing)

1. Is the worker process running? Check the process or container, then its log for the last claim.
2. Can it connect? The worker uses `SYSTEM_DATABASE_URL` (the `udofin_system` login, which has no password in
   migrations and must have the `service_role` grant). Recheck the credential and the grant (see
   [`supabase-setup.md`](supabase-setup.md)); audit finding R-10 notes the grant can fail silently on a managed project.
3. Restart the worker. Leases mean no event is lost; work in flight is taken over after its lease expires.

### 5.3 Expired leases (`expiredLeases` stays above zero)

A worker claimed events and stopped without finishing. If it is simply gone, the events are taken over automatically
once a live worker polls. If `expiredLeases` does not fall, **no worker is claiming**: go to 5.2. If a handler hangs
(for example a provider call without a timeout), the same event will be abandoned again and end up dead after its last
attempt: fix the handler, then replay as in 5.1.

### 5.4 Never

- Do not delete events to make a count go down.
- Do not replay a batch you have not read.
- Do not widen the system login's grants to make a command work.

## 6. What does not exist yet

Each of these is a gap, not a hidden feature:

- No dashboard, no alert rules, no pager integration (see [`observability-spec.md`](observability-spec.md)).
- No portal screen for dead events and no bulk replay. Replay is one event at a time, on purpose.
- No payload viewer. If a payload is needed to diagnose, an engineer reads it deliberately and does not copy it.
- No automatic poller for `ops.outbox_health()`. The worker could publish it as metrics (spec only).
- No drill: replay has been exercised by database and integration tests only, not rehearsed with an operator.

## 7. Evidence

- `supabase/tests/013_remediation_db.test.sql` and `supabase/tests/007_idempotency_outbox.test.sql`: the functions refuse
  non-system roles, refuse an e-mail-shaped operator, replay only dead events and write the audit record without a payload.
- `services/api/test/integration/api.integration.test.ts`: dead-lettering, lease takeover, retry limits and safe logging
  against a real database.
