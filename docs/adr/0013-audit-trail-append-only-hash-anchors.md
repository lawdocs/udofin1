# ADR-0013: Audit trail — append-only rows, per-row hashes and exported anchors

- **Status:** Accepted (baseline, pending owner approval) — the anchoring/export job is not yet built
- **Date:** 2026-10-10
- **Related:** ADR-0005, ADR-0006, ADR-0014, ADR-0015, ADR-0024

## Context

- Lenders, their auditors and RBI inspection may ask who did what, when, on whose data. Lenders' IT-outsourcing and cybersecurity directions are expected to flow down requirements for vendor audit trails and log retention (research: likely, `docs/research/2026-10-10/rbi-digital-lending.md` §5, DL-31).
- CERT-In Directions (28 Apr 2022) require ICT logs for a rolling 180 days within India (research: likely).
- An audit trail is only useful if a caller cannot forge the actor and an insider cannot silently edit or delete history, including a database administrator.
- Audit records must not become a second store of personal data (ADR-0009).

## Decision

1. **Business audit events** go to `audit.events`: time, actor type (`borrower`, `staff`, `system`, `partner`), actor user and organisation, tenant (`tenant_org_id`), dotted action name, entity type and id, outcome (`success`, `denied`, `failure`), request id, correlation id and metadata. **Metadata never contains personal data or identity numbers.**
2. **Append-only:** a trigger rejects every UPDATE and DELETE on `audit.events` and `audit.anchors`. Corrections are new events.
3. **Actor cannot be forged:** users have no INSERT grant. User-context code writes only through `private.record_audit_event(...)` (security definer), which derives the actor from the session (`auth.uid()`), classifies borrower vs staff, and attributes staff to the platform organisation first, else the tenant.
4. **Per-row hash:** a trigger stamps `row_hash` = SHA-256 over the row's canonicalised content.
5. **Range digests and anchors:** `private.audit_digest(from, to)` recomputes every row hash from content and hashes them in order, so editing a row is detected even if its stored `row_hash` was also rewritten. A scheduled anchoring job stores digests in `audit.anchors` and **exports each digest outside the database** to write-once storage (an object-lock bucket) and/or LawDocsComply; `exported_ref` records where.
6. **Other append-only histories:** `lending.application_events` (written by the lifecycle trigger in the same transaction as the status change; ADR-0015), `consent.records` (ADR-0014), `payments.provider_events`, `servicing.schedule_snapshots` and `schedule_installments`.
7. **Who can read:** holders of `audit.read` for their tenant; platform auditors (platform-grantable) across tenants; anchors only to platform `audit.read`.
8. **Cross-tenant staff access** (platform staff reading lender data) is recorded by the API as audit events (planned with the first API routes).
9. Operational logs (application, access, security) are separate from business audit events and follow ADR-0010 residency and retention (at least 180 days in India).

## Alternatives considered

| Option                                                 | Why rejected                                                                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hash chain (each row includes the previous row's hash) | Serialises inserts on one chain head and adds contention; range digests plus external anchors detect the same edits and deletions with concurrent writes. |
| Audit only in application log files                    | Mutable, hard to query, easy to lose; no actor guarantee.                                                                                                 |
| Database statement logging only                        | Records SQL, not business meaning; actor attribution would be the database role, not the person.                                                          |
| External SaaS audit service                            | Residency (ADR-0010) and cost; still needs in-database integrity for evidence.                                                                            |

## Consequences

**Positive**

- Actor attribution is enforced by the database, not by caller discipline.
- Edits and deletions can be detected by recomputing digests and comparing with exported anchors.
- Lifecycle history is written atomically with each change, so no status change exists without a trace.

**Negative**

- The audit table grows without bound; it will need partitioning and an archive policy (research recommends 1 year hot and 2 years archive on write-once storage for security logs; recommendation).
- Inserting through a security-definer function costs a little more than a plain insert.

**Risks and known gaps (baseline)**

- **Detection depends on export.** Until the anchoring job exports digests outside the database, a superuser could delete rows and recompute or delete in-database anchors (anchors are append-only only against non-superusers; triggers can be disabled by an owner).
- **Canonicalisation weakness:** the row hash uses `concat_ws('|', ...)`, which skips NULL values and does not escape `|`. Moving a value between adjacent nullable fields (for example `actor_user_id` and `actor_org_id`) would not change the hash. A future migration should hash an unambiguous encoding (for example a JSON array with explicit nulls) for new rows.
- Events written by `service_role` directly bypass `record_audit_event`, so system code must set actor fields correctly.
- Anything between the last anchor and an attack is detectable only once the next anchor is exported; the anchoring interval sets that window.

## Compliance and security notes

- Supports lender expectations of vendor audit trails and CERT-In log retention (research: likely). Evidence: the audit table, exported anchors with object-lock retention, verification reports.
- Primary-source verification gate applies (README).

## Verification

- `supabase/tests/003_lifecycle_and_integrity.test.sql`: audit actor is derived from the session, not supplied by the caller; users cannot insert audit rows directly; tampering with an audit row, even as superuser with the trigger disabled, changes the digest; audit events, consent records, application history and received schedules cannot be edited or deleted; every status change left exactly one lifecycle event.
- `supabase/tests/002_tenant_isolation.test.sql`: a credit officer without `audit.read` sees no audit events.
- Planned: a scheduled verification job that recomputes digests for exported ranges and alerts on mismatch; a test that an anchor's `exported_ref` points to object-locked storage.

## Revisit triggers

- Design of the anchoring job and its interval; LawDocsComply integration.
- Audit volume requires partitioning.
- A lender or auditor requests a different evidence format (for example signed exports).
