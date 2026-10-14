# Architecture Decision Records (ADRs)

This folder records the significant technical and architectural decisions for Udofin, the Lending Service Provider (LSP) platform. Each record explains what was decided, why, what else was considered, and what the decision costs us.

## What an ADR is

An ADR is a short document, usually one to two pages, about **one** decision. The decision should be hard or expensive to reverse, or something a partner lender, auditor or new engineer would ask about. Examples: "the lender's LMS is the system of record", "no Udofin pool account", "row level security as a second layer".

An ADR is not a design document, a specification or a policy. It points to the code, migrations, tests and research notes that hold the detail.

Write a new ADR when a change:

- alters data ownership, tenancy, money flows, residency or security boundaries;
- adds or replaces a major dependency, provider or hosting platform;
- changes a public contract (API, event, webhook) in a breaking way;
- changes how Udofin meets a regulatory or app-store requirement.

## Status values

| Status                                          | Meaning                                                                                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Proposed**                                    | Agreed direction that is **not yet implemented** in code, or still needs the owner's decision. It may change without a superseding ADR.                                                                   |
| **Accepted**                                    | Approved by the product owner and engineering, and binding on new work.                                                                                                                                   |
| **Accepted (baseline, pending owner approval)** | Already implemented in the baseline code (2026-10-10) and enforced by tests, but not yet formally approved by the product owner. Treat as binding until the owner approves it or a new ADR supersedes it. |
| **Superseded by ADR-NNNN**                      | Replaced by a later ADR. The old file stays, unchanged except for its status line, so the history is readable.                                                                                            |

An ADR that is only partly built says so in its **Implementation state** section. The status describes the decision; the implementation state describes the code.

## Rules for writing ADRs

1. One decision per file, named `NNNN-kebab-title.md`, numbered in sequence. Numbers are never reused.
2. Once an ADR is Accepted, do not rewrite it. Write a new ADR that supersedes it, and update the old one's status line only.
3. Link code by repo-relative path (for example `supabase/migrations/20261010000400_lending_core.sql`) and research by `docs/research/2026-10-10/<file>.md`.
4. Never write that Udofin "is compliant". State the control, the evidence it produces, and what remains to verify.
5. Regulatory facts carry the research status label: **confirmed**, **likely**, **interpretation** or **unverified**. Do not add regulation names, paragraph numbers, dates or provider capabilities that are not in the research notes or the code.
6. Be honest about trade-offs. Every ADR lists negative consequences and risks, not only benefits.

### Primary-source verification gate (applies to every ADR that cites regulation)

During the 2026-10-10 research the sandbox could not open rbi.org.in or other primary sources (fetch failed on DNS; the proxy blocked HTTPS), and the shared web-search budget ran out. The research findings therefore rest on search snippets and secondary sources such as law firms and the press. In these notes "confirmed" usually means "corroborated by several secondary sources or a search extract of an official page", **not** "read in the primary text".

Every regulatory paragraph reference must be verified against the primary RBI, UIDAI, MeitY or NPCI text before anyone relies on it in a contract, a policy or a launch. **This is a release gate.** A compliance owner or counsel must be appointed to do it (open decision for the owner).

## Template

```markdown
# ADR-NNNN: <decision in a few words>

- **Status:** Proposed | Accepted | Accepted (baseline, pending owner approval) | Superseded by ADR-NNNN
- **Date:** YYYY-MM-DD
- **Related:** ADR-NNNN, ...

## Context

The problem, the forces at play (business, regulatory, technical) and the constraints. Facts only, with sources and research status labels.

## Decision

What we will do, stated as rules. Include what is out of scope.

## Implementation state (optional)

What exists in code today and what is planned.

## Alternatives considered

Each realistic option and why it was rejected.

## Consequences

Positive, negative and risks.

## Compliance and security notes

Which requirements this decision supports, with research status labels, and what still needs primary-source verification. No compliance claims.

## Verification

How tests, reviews or checks prove the decision holds (name the test files).

## Revisit triggers

Events that should cause this decision to be reopened.
```

## Index

| ADR                                                                  | Title                                                                            | Status                                             | Area              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------- |
| [0001](0001-record-architecture-decisions.md)                        | Record architecture decisions                                                    | Accepted (baseline, pending owner approval)        | Process           |
| [0002](0002-monorepo-pnpm-turborepo-typescript-6.md)                 | Monorepo with pnpm, Turborepo and TypeScript 6                                   | Accepted (baseline, pending owner approval)        | Tooling           |
| [0003](0003-modular-monolith-fastify.md)                             | Modular monolith on Fastify                                                      | Accepted (baseline, pending owner approval)        | Backend           |
| [0004](0004-postgres-supabase-sql-first-migrations-kysely.md)        | Postgres on Supabase, SQL-first migrations, Kysely                               | Accepted (baseline, pending owner approval)        | Data              |
| [0005](0005-tenancy-shared-schema-rls-defense-in-depth.md)           | Tenancy: shared schema with RLS as defence in depth                              | Accepted (baseline, pending owner approval)        | Security / data   |
| [0006](0006-authorization-roles-permissions-maker-checker.md)        | Authorisation: roles, permissions and maker-checker                              | Accepted (baseline, pending owner approval)        | Security          |
| [0007](0007-lender-lms-is-system-of-record.md)                       | The lender's LMS is the loan system of record                                    | Accepted (baseline, pending owner approval)        | Domain            |
| [0008](0008-money-flows-no-pool-accounts-payment-providers.md)       | Money flows: no pool accounts; payment providers                                 | Accepted (baseline, pending owner approval)        | Payments          |
| [0009](0009-data-minimisation-lender-owned-kyc-and-bureau.md)        | Data minimisation; KYC and bureau owned by lenders                               | Accepted (baseline, pending owner approval)        | Privacy           |
| [0010](0010-hosting-and-data-residency.md)                           | Hosting and data residency                                                       | Proposed                                           | Infrastructure    |
| [0011](0011-background-jobs-outbox-pg-boss.md)                       | Background jobs: transactional outbox and pg-boss                                | Proposed                                           | Backend           |
| [0012](0012-api-and-event-contracts.md)                              | API and event contracts                                                          | Accepted (baseline, pending owner approval)        | Integration       |
| [0013](0013-audit-trail-append-only-hash-anchors.md)                 | Audit trail: append-only rows, hashes and anchors                                | Accepted (baseline, pending owner approval)        | Security          |
| [0014](0014-consent-ledger.md)                                       | Consent ledger                                                                   | Accepted (baseline, pending owner approval)        | Privacy           |
| [0015](0015-application-lifecycle-state-machine-in-db-and-domain.md) | Application lifecycle as a state machine in DB and domain                        | Accepted (baseline, pending owner approval)        | Domain            |
| [0016](0016-mobile-expo-permissions-and-ota-policy.md)               | Mobile: Expo, device permissions and OTA policy                                  | Accepted (baseline, pending owner approval)        | Mobile            |
| [0017](0017-web-portals-nextjs-csp.md)                               | Web portals: Next.js with strict CSP                                             | Accepted (baseline, pending owner approval)        | Web               |
| [0018](0018-grievance-path-and-equator-referral.md)                  | Grievance path and Equator referral                                              | Proposed                                           | Conduct           |
| [0019](0019-ai-usage-boundaries.md)                                  | AI usage boundaries                                                              | Proposed                                           | Conduct           |
| [0020](0020-product-scope-and-payday-exclusion.md)                   | Product scope and payday exclusion                                               | Accepted (baseline, pending owner approval)        | Product           |
| [0021](0021-design-tokens-and-tenant-branding-limits.md)             | Design tokens and limits on lender branding                                      | Accepted (baseline, pending owner approval)        | UI                |
| [0022](0022-multi-lender-offer-comparison.md)                        | Multi-lender offer comparison                                                    | Proposed                                           | Conduct           |
| [0023](0023-collections-and-dlg-separation.md)                       | Collections and DLG kept separate                                                | Proposed                                           | Conduct / finance |
| [0029](0029-borrower-onboarding-and-loan-request.md)                 | Borrower onboarding, consent evidence, loan requests, step-up                    | Accepted (pending owner review of the Phase 05 PR) | Borrower, conduct |
| [0027](0027-idempotency-in-postgres.md)                              | Idempotency records in Postgres, in the business transaction                     | Accepted                                           | API, database     |
| [0026](0026-portal-sessions-bff-cookies.md)                          | Portal sessions through a backend-for-frontend with HttpOnly cookies             | Accepted                                           | Portals, auth     |
| [0025](0025-two-person-change-control.md)                            | Two-person change control for administrative changes                             | Accepted                                           | Tenancy, audit    |
| [0024](0024-ecosystem-product-boundaries.md)                         | Boundaries between Udofin, Finbyx, LawDocsComply and Equator                     | Proposed                                           | Ecosystem         |
| [0030](0030-lender-routing-and-offer-comparison.md)                  | Lender routing, consented sharing, lender-reported status, offers and comparison | Proposed                                           | Phase 06          |
| [0031](0031-kfs-documents-and-offer-acceptance.md)                   | KFS, documents, acknowledgement, acceptance and signing boundary                 | Proposed                                           | Phase 07          |

## Owner actions

All baseline ADRs await the product owner's approval. The owner should read each one, then either approve it (status becomes **Accepted**) or ask for a change (a new ADR supersedes it). The open owner decisions that block Proposed ADRs are listed in each ADR's Context or Revisit triggers.
