# Udofin documentation

| Area         | Document                                                             | Purpose                                                          |
| ------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Start here   | [`../CLAUDE.md`](../CLAUDE.md)                                       | Engineering rules for every change                               |
| Architecture | [`architecture/overview.md`](architecture/overview.md)               | System context, containers, modules, request and money flows     |
|              | [`architecture/ecosystem.md`](architecture/ecosystem.md)             | How Udofin, Finbyx, LawDocsComply and Equator connect            |
| Decisions    | [`adr/`](adr/README.md)                                              | Architecture Decision Records                                    |
| Data         | [`data/entity-model.md`](data/entity-model.md)                       | Entity model and ER diagrams                                     |
|              | [`data/ownership.md`](data/ownership.md)                             | Who owns each record, classification, residency, retention       |
|              | [`data/migrations.md`](data/migrations.md)                           | Migration rules and review checklist                             |
| APIs         | [`api/README.md`](api/README.md)                                     | API conventions (auth, errors, idempotency, webhooks)            |
|              | [`api/integration-contracts.md`](api/integration-contracts.md)       | Events and APIs shared with other products and lenders           |
| Integrations | [`integrations/register.md`](integrations/register.md)               | Provider register and adapter contracts                          |
| Regulatory   | [`regulatory/register.md`](regulatory/register.md)                   | Dated register of laws, directions and policies                  |
|              | [`regulatory/controls-matrix.md`](regulatory/controls-matrix.md)     | Requirement → control → evidence → test                          |
| Security     | [`security/threat-model.md`](security/threat-model.md)               | Threats, abuse cases and controls                                |
|              | [`security/checklist.md`](security/checklist.md)                     | Gates for every PR and release                                   |
|              | [`security/mobile-permissions.md`](security/mobile-permissions.md)   | Device-permission plan                                           |
|              | [`security/risk-acceptances.md`](security/risk-acceptances.md)       | Accepted risks with owners and review dates                      |
| Testing      | [`testing/strategy.md`](testing/strategy.md)                         | Test layers, how to run, release gates, definition of done       |
| Operations   | [`operations/deployment.md`](operations/deployment.md)               | Environments, deployment, rollback, backup/DR, monitoring        |
| Product      | [`product/roadmap.md`](product/roadmap.md)                           | Phased plan with instructions you can give for each phase        |
|              | [`product/open-decisions.md`](product/open-decisions.md)             | Decisions needed from the product owner                          |
|              | [`product/module-status.md`](product/module-status.md)               | What exists, what is next                                        |
|              | [`product/loan-products.md`](product/loan-products.md)               | Product catalogue and feasibility                                |
|              | [`product/competitive-analysis.md`](product/competitive-analysis.md) | Competitor and UX research summary                               |
| Specs        | [`specs/`](specs/README.md)                                          | Approved module specifications (one per module, added per phase) |
| Research     | [`research/2026-10-10/`](research/2026-10-10/README.md)              | Source research notes behind the decisions                       |

## Added in Phase 03

- [`auth/README.md`](auth/README.md): authentication and session architecture (portals, mobile, database context).
- [`api/idempotency-and-outbox.md`](api/idempotency-and-outbox.md) and [`api/openapi.json`](api/openapi.json): idempotency, outbox and the generated API description.
- [`operations/local-development.md`](operations/local-development.md): commands to run and test everything locally.
- [`specs/03-application-foundation.md`](specs/03-application-foundation.md): what was built, limits and the verification list.
- [`specs/04-lender-onboarding-configuration.md`](specs/04-lender-onboarding-configuration.md): Phase 04 specification (draft, awaiting approval).
