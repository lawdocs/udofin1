# ADR-0001: Record architecture decisions

- **Status:** Accepted (baseline, pending owner approval)
- **Date:** 2026-10-10
- **Related:** all ADRs in this folder; [README](README.md)

## Context

- Udofin is an LSP. Partner lenders (regulated entities, REs) remain responsible for what an LSP does and must run due diligence on it before and during the relationship: technical ability, data privacy and storage, fair conduct and compliance (research: confirmed (secondary), `docs/research/2026-10-10/rbi-digital-lending.md`, DL-02). Lenders will ask _why_ the system is built the way it is, not only _what_ it does.
- The product owner is a legal and finance domain expert, not an engineer. Decisions must be readable without reading code.
- The baseline (2026-10-10) already encodes many decisions in migrations, triggers and tests (`supabase/migrations/`, `supabase/tests/`). Without a written record, the reasons behind constraints such as "only the system can mark a payment succeeded" are easy to remove by accident.
- Regulatory research for this baseline could not read primary sources. Decisions that rest on regulation must say so and carry the research status, so they can be re-checked later.

## Decision

1. Record significant decisions as Architecture Decision Records in `docs/adr/`, one decision per file, using the MADR-style template in the [README](README.md).
2. Status values: Proposed, Accepted, Accepted (baseline, pending owner approval), Superseded by ADR-NNNN.
3. Decisions already implemented in the 2026-10-10 baseline are recorded as **Accepted (baseline, pending owner approval)**. The owner approves or supersedes each one.
4. Accepted ADRs are not rewritten. A change is a new ADR that supersedes the old one; only the old status line is edited.
5. Every ADR lists alternatives and negative consequences, links code and tests by repo-relative path, and states how the decision is verified.
6. Any regulatory statement carries the research label (confirmed / likely / interpretation / unverified) and is subject to the primary-source verification gate described in the README.
7. A pull request that changes a recorded decision must reference the ADR it implements or supersedes.

## Alternatives considered

| Option                                                       | Why rejected                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| No written record; rely on code comments and commit messages | Comments explain _how_, rarely _why_ or what was rejected. Not readable by the owner or lender auditors. |
| Wiki or shared-drive documents outside the repo              | Drift from the code; no review in the same pull request; history harder to audit.                        |
| Long design documents per feature                            | Mix many decisions; hard to supersede one part; tend to go stale.                                        |
| Decisions only in pull-request descriptions                  | Hard to find later; not indexed; no status lifecycle.                                                    |

## Consequences

**Positive**

- Lender due-diligence questions about architecture can be answered from one place.
- New engineers and agents can see which constraints are deliberate (for example the append-only tables) before changing them.
- Regulatory assumptions are visible and can be re-verified when primary texts are read.

**Negative**

- Writing and reviewing ADRs costs time on every significant change.
- ADRs can still drift from code if reviews do not check them.

**Risks**

- An ADR may be read as a compliance statement. Mitigation: rule 4 of the README forbids compliance claims; each ADR states what remains to verify.
- Baseline ADRs could be treated as approved before the owner has read them. Mitigation: the status text says "pending owner approval".

## Compliance and security notes

- ADRs are internal engineering records. They are not policies, contracts or regulatory filings, and must not be shared with lenders as evidence of compliance without review.
- Research limitation: see the verification gate in the [README](README.md).

## Verification

- Review checklist for pull requests that touch `supabase/migrations/`, `services/api/src/`, `packages/*/src/`, `apps/*/app.config.ts`, `apps/*/proxy.ts` or hosting configuration: "Does this change a recorded decision? If so, which ADR?" (not yet automated; no CI workflow exists in `.github/workflows/` at baseline).
- The README index must list every ADR file in this folder.

## Revisit triggers

- The team adopts a different documentation system (for example a docs site) that can hold ADRs.
- ADRs are found to be routinely out of date in reviews.
