# Security risk acceptances

Each accepted risk has an owner, a reason, a scope and a review date. Nothing here may be
accepted for code that runs on servers or on borrowers' devices.

| ID     | Item                                                                                 | Scope                                                                            | Why accepted                                                                                                                      | Compensating control                                                                                                                                                                                                                                                                   | Owner                                     | Review by               |
| ------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------- |
| RA-001 | `GHSA-86w9-cpqp-85rv` (node-forge ≤1.4.0, high)                                      | `apps/mobile` → `expo` → `@expo/cli` (developer/build tooling only)              | No patched version published; not bundled into the app binary or any server image                                                 | CI audit still blocks every other high/critical advisory; `scripts/check-audit-ignores.mjs` (CI `quality` job) fails if `node-forge` (RA-001) or `braces` (RA-002) enters the production dependency closure of the API, its libraries or either portal; re-check on every Expo upgrade | Product owner (pending engineering owner) | 2026-11-10              |
| RA-002 | `GHSA-vfj7-8cjw-p6xm` (braces ≤3.0.3, high)                                          | `apps/mobile` → `expo` → `@expo/metro` → `micromatch` (bundler, build-time only) | No patched version in this dependency path; only processes developer-controlled file globs                                        | As RA-001                                                                                                                                                                                                                                                                              | Product owner (pending engineering owner) | 2026-11-10              |
| RA-003 | Container base image and the gitleaks scanner image are pinned by tag, not by digest | `infra/docker/api.Dockerfile`, `.github/workflows/ci.yml`                        | Digests could not be resolved from this environment (no registry access). Dependabot's docker ecosystem now tracks the base image | Build runs only in CI with a read-only token; production images will be built from a pinned digest and scanned before the first real deployment (Phase 03 / 11)                                                                                                                        | Product owner (pending engineering owner) | Before first deployment |

Configured in `package.json` → `pnpm.auditConfig.ignoreGhsas`. Remove an entry as soon as a fix is available.

## How the scope of RA-001 and RA-002 is enforced

`pnpm audit` can only ignore an advisory for the whole workspace, not for one package. The ignore therefore
also covers server-side code unless something else checks it. `scripts/check-audit-ignores.mjs` is that check,
run in the CI `quality` job (suggested in section 15 of `docs/audits/phase-01-repository-baseline-audit.md`):

- It runs `pnpm ls --prod --depth Infinity` for `@udofin/api`, `@udofin/adapters`, `@udofin/contracts`,
  `@udofin/domain` and the two portals (with the workspace packages they depend on) and **fails** if `node-forge`
  (RA-001) or `braces` (RA-002) appears anywhere in that production closure. `apps/mobile` is deliberately not
  checked: it is the only place the acceptance covers.
- It also **fails** if `package.json` ignores any advisory the script does not map to an RA entry, so a third ignore
  cannot be added without a scope decision and a row in the table above.
- It fails (exit code 2) rather than passing if `pnpm ls` cannot see the installed dependencies.

Checked on 14 October 2026 against the committed lockfile: neither package is in the production closure of those
workspaces, and both are in `apps/mobile` (`expo` → `@expo/cli`). The check proves the closure at the time it runs;
it does not change the review date or the owner's acceptance, and it does not cover a package installed outside pnpm.
