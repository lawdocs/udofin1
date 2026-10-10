# Infrastructure

| Path                    | Status                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker/api.Dockerfile` | API image (multi-stage, non-root). Built in CI on every PR.                                                                                                                       |
| Railway                 | Dev/staging only, synthetic data only (no India region). Deploy from the Dockerfile. `railway.json`/`railway.toml` are not used because Railway stops reading them on 2026-12-01. |
| AWS ap-south-1 (Mumbai) | Planned production home for compute, object storage (S3 + KMS), logs. Infrastructure-as-code (OpenTofu/Terraform) will live in `infra/aws/` (Phase 03/11).                        |
| Supabase (Mumbai)       | Postgres + Auth. Schema managed only through `supabase/migrations`.                                                                                                               |

See `docs/operations/deployment.md` and ADR 0010.
