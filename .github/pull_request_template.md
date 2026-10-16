## What and why

<!-- Business objective in plain English, and the approved spec / ADR this implements. -->

## Scope

- [ ] Only the approved module/phase is changed (no unrelated modules)
- [ ] Out of scope items listed below

## Database

- [ ] No migration, or migration reviewed against `docs/data/migrations.md` (locking, data loss, backward compatibility, RLS + grants on new tables, rollback / forward-fix)
- [ ] pgTAP tests added/updated, including negative and cross-tenant cases

## Security and privacy

- [ ] Authorisation checked server-side and tenant isolation tested
- [ ] No secrets, credentials or real borrower data in code, tests, fixtures or logs
- [ ] No new personal data stored without an entry in `docs/data/ownership.md`
- [ ] Mobile: no new permissions, or permission plan updated (`docs/security/mobile-permissions.md`)

## Regulatory

- [ ] Affected rows in `docs/regulatory/controls-matrix.md` updated (status stays honest: confirmed / likely / unverified)

## Evidence

<!-- Paste the commands you ran and their results: pnpm lint, pnpm typecheck, pnpm test, db tests. -->

## Known limitations / follow-ups
