# Lender onboarding API (Phase 04, addendum A)

All routes are under `/v1/onboarding`, require a staff session with the second factor, and are listed in `docs/api/openapi.json`. Writes are POSTs with an `Idempotency-Key`. Reads use row-level security: a lender sees only its own records; Udofin staff see lenders for which their role carries `onboarding.read`.

| Area                | Routes                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference           | `GET institution-categories`, `GET service-categories`, `POST institution-categories/:key/signoff` and `/revoke-signoff` (compliance)                                                                   |
| Lenders             | `GET lenders`, `POST lenders` (create profile), `GET lenders/:id`, `POST lenders/:id/profile`, `POST lenders/:id/verification/submit`, `POST .../verification/decision`, `GET .../verification-history` |
| Accounting / Ind AS | `GET/POST lenders/:id/accounting-profiles`, `POST accounting-profiles/:id/submit`, `POST accounting-profiles/:id/decision`                                                                              |
| Services            | `GET/POST lenders/:id/services`, `POST services/:id/revise`, `POST service-versions/:id/agree`, `/activate`, `/state`                                                                                   |
| Requirements        | `GET lenders/:id/requirements`, `POST .../requirements/generate`, `POST .../requirements`, `POST requirements/:id/status`, `POST requirements/:id/dependencies`                                         |
| Integrations        | `GET/POST lenders/:id/integrations`, `POST integrations/:id/result`, `/exception`, `/exception/decision`                                                                                                |
| Contracts           | `GET/POST lenders/:id/contracts`, `POST contracts/:id/decision`                                                                                                                                         |
| Documents           | `GET/POST lenders/:id/documents`, `GET documents/:id/content`                                                                                                                                           |
| Gates               | `GET lenders/:id/gate/conditions`, `GET/POST lenders/:id/gate-requests`, `POST gate-requests/:id/decision`, `/cancel`                                                                                   |

## Rule codes

Problem `code` values the database raises on purpose: `self_approval` (403), `gate_not_met` (409, detail lists unmet condition keys), `gate_order`, `gate_stale`, `evidence_required`, `unconfirmed_not_verifiable`, `version_immutable`, `agreed_scope_required`, `dependency_open` (409), `unsafe_free_text` (422), `document_type_mismatch` / `document_too_large` / `invalid_reference` (413/422), `document_store_unavailable` (503).

## Documents

Interim transfer: base64 in JSON, at most 8 MiB decoded, PDF/PNG/JPEG checked by signature, SHA-256 computed on the server, stored under an opaque key. Streaming upload and pre-signed transfer come with the AWS deployment. The local-disk store (`LOCAL_DOCUMENT_DIR`) is development-only and refused in staging and production; until the S3/KMS adapter is wired document routes return 503 there.

## Lists

Per-lender lists are bounded (documents and histories return the newest 200) and are not cursor-paginated.
