# ADR-0002: Monorepo with pnpm workspaces, Turborepo and TypeScript 6

- **Status:** Accepted (baseline, pending owner approval)
- **Date:** 2026-10-10
- **Related:** ADR-0003, ADR-0012, ADR-0021, ADR-0024

## Context

- Udofin has several deliverables that share types and rules: a borrower mobile app (`apps/mobile`), two web portals (`apps/ops-portal`, `apps/lender-portal`), an API (`services/api`), and shared packages (`packages/domain`, `packages/contracts`, `packages/design-tokens`, `packages/adapters`).
- A rule such as "money is integer paise" or "the application lifecycle" must be identical in every app. Copying it across repositories invites drift.
- The team is small. Tooling must be simple to run locally and in CI.
- `typescript@latest` is 7.0.2, but typescript-eslint 8.71.1 declares a peer of `typescript >=4.8.4 <6.1.0`, and the TS 7 compiler API is marked "Not ready", so type-aware linting cannot run on TS 7 (research: confirmed, `docs/research/2026-10-10/infra-stack.md` §8).
- Sister products (Finbyx, LawDocsComply, Equator) are separate products with separate repositories, databases and release cycles (ADR-0024). This monorepo is for Udofin only.

## Decision

1. One repository for Udofin, organised as pnpm workspaces: `apps/*`, `services/*`, `packages/*` (`pnpm-workspace.yaml`).
2. Package manager pinned: `packageManager: pnpm@10.28.0`. Dependency lifecycle scripts are blocked except an explicit allowlist (`onlyBuiltDependencies: [esbuild]`). `engine-strict=true`. `node-linker=hoisted` because React Native / Expo autolinking is most reliable with a hoisted layout (`.npmrc`).
3. Task orchestration with Turborepo 2 (`turbo.json`): `build`, `typecheck`, `lint` and `test` depend on dependencies' `build`; outputs are cached.
4. TypeScript pinned to `~6.0.3` in every workspace. Strict compiler options shared through `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, NodeNext modules).
5. ESLint 10 flat config at the root (`eslint.config.mjs`) with type-checked rules (`no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, `no-explicit-any`, `no-console`, `eqeqeq`). `packages/domain` may not import I/O, frameworks or vendor SDKs (enforced by `no-restricted-imports`).
6. Prettier for formatting. `pnpm check` runs format check, lint, typecheck and tests.
7. Runtime: Node 24 LTS as the development target (`.nvmrc`), `engines.node >=22.13.0 <25`.
8. React is pinned to 19.2.3 across workspaces through `pnpm.overrides` so the mobile app and portals use one React version.

## Alternatives considered

| Option                                | Why rejected                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One repository per app or service     | Shared rules (money, lifecycle, contracts, tokens) would be published and versioned separately; drift between app and API becomes likely; more release overhead for a small team. |
| Nx instead of Turborepo               | Research found Nx not needed at this size; module boundaries can be enforced with ESLint rules (`infra-stack.md` §9, interpretation).                                             |
| TypeScript 7 now                      | Breaks type-aware linting (peer range and "API not ready", confirmed). Optional later: run `tsgo` as a fast, non-gating type check (research recommendation).                     |
| Isolated (non-hoisted) `node_modules` | pnpm's strictness is valuable, but Expo / React Native autolinking is the deciding constraint today.                                                                              |
| npm or Yarn workspaces                | No specific advantage found; pnpm's lifecycle-script blocking is a useful supply-chain control.                                                                                   |

## Consequences

**Positive**

- One change can update the database rule, the domain rule and the test that keeps them in sync (see ADR-0015).
- Shared packages compile once and are consumed through workspace links.
- Strict compiler and lint settings catch whole classes of bugs (unhandled promises, unchecked indexes, missing switch cases).

**Negative**

- The hoisted layout weakens pnpm's protection against "phantom" dependencies (a package using a dependency it did not declare).
- The repository grows with mobile, web and backend tooling; contributors need Node, pnpm and, for the database tests, PostgreSQL with pgTAP.
- pnpm 10.28.0 is behind the current major (research notes 12.10.1, `infra-stack.md` §9); an upgrade must be planned deliberately.

**Risks**

- An automated dependency update could pull TypeScript 7 and break linting. Mitigation in place: `.github/dependabot.yml` ignores `typescript` versions `>=6.1.0`.
- Supply-chain risk from transitive packages. Mitigation in place: lifecycle scripts blocked by default. Further controls such as a minimum release age are recommended by research (feature names: likely) but not configured.

## Compliance and security notes

- No regulatory requirement drives the repository layout. The relevant control is supply-chain hygiene, which lenders' IT-outsourcing due diligence may ask about (research: the 31 Jul 2026 supervisory directions flow down to vendors, likely; `rbi-digital-lending.md` §5).
- `.gitignore` excludes `.env*` files, keys, keystores and data dumps so secrets and borrower data are not committed.

## Verification

- `pnpm check` (root `package.json`) runs `format:check`, `lint`, `typecheck` and `test` across workspaces.
- The `packages/domain` import restriction is enforced by ESLint on every lint run.
- `.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile`, `format:check`, `build`, `lint`, `typecheck` and `test` on every pull request, plus `pnpm audit --prod --audit-level high` and a gitleaks secret scan.

## Revisit triggers

- typescript-eslint supports TypeScript 7 and the TS 7 API is declared ready.
- Expo / React Native autolinking works reliably with an isolated `node_modules` layout.
- Build or CI times become a bottleneck, or the number of packages grows enough to need Nx-style project graphs.
- pnpm major upgrade.
