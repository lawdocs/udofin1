# ADR-0015: Application lifecycle as one state machine, enforced in the database and the domain package

- **Status:** Accepted (baseline, pending owner approval)
- **Date:** 2026-10-10
- **Related:** ADR-0004, ADR-0006, ADR-0007, ADR-0013, ADR-0022

## Context

- One borrower need is shared with several lenders. Each lender decides on its own application; the borrower may accept at most one.
- Who may move an application matters legally: the lender makes the credit decision; only the borrower accepts an offer; disbursement is a fact reported by the lender's systems, not a button in Udofin.
- Status rules scattered across services drift and are hard to audit. The API, workers and future clients must all obey the same rules.

## Decision

1. **Model:** a borrower creates one `lending.loan_requests` row per need. With consent, the system creates one `lending.applications` row per lender (unique per request and lender), pinned to an approved product version of that lender.
2. **One definition, two enforcers.** The lifecycle is declared as data:
   - in `packages/domain/src/lifecycles/application.ts` (`APPLICATION_STATUSES`, `APPLICATION_TRANSITIONS` with allowed actors), built on the generic `defineStateMachine` (`packages/domain/src/state-machine.ts`);
   - in `lending.application_transitions` (migration `20261010000400_lending_core.sql`), enforced by a trigger.
     `packages/domain/test/lifecycle-sync.test.ts` fails if the two differ in statuses, transitions or actors.
3. **States:** draft, submitted, under_review, info_requested, approved, rejected, offer_accepted, agreement_pending, agreement_executed, disbursement_pending, disbursed, withdrawn, expired, cancelled. Terminal: rejected, disbursed, withdrawn, expired, cancelled.
4. **Actors:** `borrower` (the applicant), `lender` (an authenticated non-borrower user with the lender's permissions), `system` (a trusted backend process with no end-user session, e.g. a verified LMS or eSign callback). Key rules:
   - only the borrower submits, withdraws or moves `approved → offer_accepted`;
   - only the lender or system reviews, approves, rejects or cancels;
   - only the system moves to `agreement_pending`, `agreement_executed` and `disbursed`;
   - `disbursed` additionally requires disbursement evidence (ADR-0007).
5. **Every status change writes a lifecycle event** (`lending.application_events`, append-only) in the same transaction, with actor, user and an optional reason passed via the transaction setting `udofin.transition_reason`. New applications must start in `draft` unless created by the system.
6. **Cross-application rules:** only one application per loan request may be past offer acceptance (partial unique index). Loan-request changes: the borrower may edit terms only in `draft`, and may only submit or withdraw; offer selection, expiry and closure are system actions.
7. **Offers:** terms are immutable once issued; only the borrower accepts or declines; an expired offer cannot be accepted; status changes from `issued` are final; at most one live offer per application; offers cannot be deleted.
8. The same `defineStateMachine` pattern is used for future lifecycles (loan accounts, complaints, mandates, collections cases).

## Alternatives considered

| Option                                                 | Why rejected                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Status checks written ad hoc in each service           | Drift, gaps and no single place to audit.                                                                    |
| Database-only enforcement                              | The API and UI need to know allowed next steps without trial and error; domain tests run without a database. |
| Application-only enforcement                           | A script, worker or future client could bypass it.                                                           |
| Workflow engine (e.g. Temporal) as the source of truth | Heavier; the database must still refuse invalid writes. Possible later for orchestration (ADR-0011).         |

## Consequences

**Positive**

- Invalid transitions are refused by the database for every writer, and the history is complete by construction.
- Product, compliance and engineering can read the lifecycle as a table.

**Negative**

- Two copies to maintain (mitigated by the sync test).
- Adding a state (for example KFS acknowledgement or cooling-off) needs a migration, a domain change and test updates together.

**Risks and known gaps (baseline)**

- The sync test parses only `20261010000400_lending_core.sql` with regular expressions. A later migration that changes transitions, or a formatting change, would not be seen. It must be updated when transitions move to a new migration.
- In the database, `lender` means any authenticated non-borrower, including platform staff (`private.current_actor()`); platform staff are kept out today only because `application.decide` is not platform-grantable. The domain package describes `lender` more narrowly.
- `system` means "no JWT claims". Any code path that runs without claims under a privileged role acts as the system (ADR-0004).
- Accepting an offer (`offers.status = accepted`) and moving the application to `offer_accepted` are separate updates; the database does not require one to imply the other. The API must do both in one transaction (or a trigger should be added).
- Offers are not checked against the pinned product version's amount, tenure and rate bounds, or the category tenure floor (ADR-0020).

## Compliance and security notes

- Encodes the reported rule that the credit decision stays with the lender (research: confirmed (secondary), `docs/research/2026-10-10/rbi-digital-lending.md` DL-11) and that money moves only on the lender's evidence. Primary-source verification gate applies (README).

## Verification

- `supabase/tests/003_lifecycle_and_integrity.test.sql`: lender approves with actor and reason recorded in the same transaction; decision time stamped; skipping steps rejected; lender cannot accept for the borrower; borrower cannot approve; only one lender proceeds past acceptance; disbursed needs evidence and is terminal; seven transitions leave seven events; loan-request edit and status rules; offer immutability, expiry and finality.
- `packages/domain/test/lifecycle-sync.test.ts`: domain and database statuses and transitions match; only the system records disbursement; no borrower approval or lender acceptance; no jump from approval to disbursement.
- `packages/domain/src/state-machine.test.ts`: only declared transitions; terminal states final; invalid definitions rejected.

## Revisit triggers

- KFS display/acknowledgement and cooling-off states are added (Phase 7).
- Co-lending or assisted (field-agent) journeys need new actors.
- Orchestration moves to a workflow engine.
