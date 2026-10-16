# API modules

The API is a modular monolith (ADR 0003). Each business capability is a module folder here, added
in the phase that implements it (`docs/product/roadmap.md`). No module code exists yet.

## Layout of a module

```
modules/<name>/
  index.ts        public interface: route registration + the functions other modules may call
  routes.ts       HTTP handlers (validation with zod, permission checks, problem+json errors)
  service.ts      use cases; one database transaction per command
  repository.ts   SQL (Kysely) — runs inside the caller's transaction and RLS context
  events.ts       events written to the outbox (CloudEvents envelope from @udofin/contracts)
  *.test.ts       tests
```

## Rules

- Modules call each other only through `index.ts`; never import another module's internals.
- Business rules that need no I/O live in `packages/domain`.
- User-initiated work runs as the `authenticated` database role with the caller's claims (RLS
  applies). Only worker code paths may use the system (`service_role`) context.
- Planned modules: identity, tenancy, consent, audit, lender-config, applications, verification,
  decisioning, offers, documents, servicing, payments, mandates, collections, grievance,
  notifications, integrations, reporting.
