# Security risk acceptances

Each accepted risk has an owner, a reason, a scope and a review date. Nothing here may be
accepted for code that runs on servers or on borrowers' devices.

| ID     | Item                                            | Scope                                                                            | Why accepted                                                                               | Compensating control                                                                                                                                    | Owner                                     | Review by  |
| ------ | ----------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------- |
| RA-001 | `GHSA-86w9-cpqp-85rv` (node-forge ≤1.4.0, high) | `apps/mobile` → `expo` → `@expo/cli` (developer/build tooling only)              | No patched version published; not bundled into the app binary or any server image          | CI audit still blocks every other high/critical advisory; API image contains only `@udofin/api` production dependencies; re-check on every Expo upgrade | Product owner (pending engineering owner) | 2026-11-10 |
| RA-002 | `GHSA-vfj7-8cjw-p6xm` (braces ≤3.0.3, high)     | `apps/mobile` → `expo` → `@expo/metro` → `micromatch` (bundler, build-time only) | No patched version in this dependency path; only processes developer-controlled file globs | As RA-001                                                                                                                                               | Product owner (pending engineering owner) | 2026-11-10 |

Configured in `package.json` → `pnpm.auditConfig.ignoreGhsas`. Remove an entry as soon as a fix is available.
