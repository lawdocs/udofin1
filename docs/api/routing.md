# Lender routing, status, decisions and offers API (Phase 06)

Machine-readable description: `openapi.json`. This page states what the schema cannot. Status: implemented and tested
against a labelled mock connector only. **No real lender system has been connected or verified.**

## Borrower routes (borrower token; idempotent POSTs need `Idempotency-Key`)

| Route                                              | Purpose                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /v1/loan-requests/{id}/lenders`               | Lenders that match the request, with each lender's sharing wording (null = sharing blocked)  |
| `POST /v1/loan-requests/{id}/selection`            | Choose up to 5 lenders (no duplicates, nothing pre-selected, replayed safely)                |
| `GET /v1/loan-requests/{id}/selection`             | Current selection and per-lender consent state                                               |
| `POST /v1/selections/{id}/items/{lenderId}/remove` | Remove a lender before routing                                                               |
| `POST /v1/loan-requests/{id}/lender-consents`      | Record the separate consent for one named lender, with the notice version and language shown |
| `POST /v1/selections/{id}/route`                   | Create one application per consented lender and queue sending; all-or-nothing                |
| `GET /v1/loan-requests/{id}/applications`          | Per-lender stage, lender-reported check status (labelled as reported), consent state         |
| `POST /v1/applications/{id}/withdraw`              | Withdraw consent and the application; stops any unsent transmission                          |
| `POST /v1/loan-requests/{id}/comparison`           | The comparison (see below). Logged on every view                                             |

What a lender receives (fixed, `minimum_payload_v1`): Udofin reference, approved request fields (category, amount in paise,
tenure in days, purpose), product version, optional display name, language, and the phone number. The phone is read at
transmission time and is never written to Udofin's application, routing, consent, audit or outbox tables.

Errors add stable codes such as `consent_required`, `lender_not_available`, `too_many_lenders`, `already_routed`,
`consent_withdrawn`, `ranking_rule_not_approved`. Clients map codes to text.

## Comparison

Exactly the approved fields per offer: lender name, amount, tenor, APR, monthly repayment, penal charges and the lender's
KFS link, as the lender supplied them. Lenders that did not offer are named with an accurate reason (declined,
no response by the deadline, still processing, consent withdrawn, offer expired, held for correction is never
disclosed as an offer). There are no badges, countdowns or "recommended" markers.
Ordering follows the approved, versioned, disclosed rule (`rule.version`, `rule.summary`); the borrower may re-sort
(`apr_bps`, `monthly_repayment_minor`, `total_repayable_minor`). With no approved rule the route answers `409
ranking_rule_not_approved` (D-16 open). The optional iOS APR filter is off unless platform staff switch on the `ios_apr_filter_enabled` setting (D-19).

## Lender routes (lender staff token; permissions `application.read` to see, `application.decide` to write)

`GET /v1/lender/applications`, `GET /v1/lender/applications/{id}`, then `acknowledge`, `checks`, `decision`, `offers`,
`offers/withdraw` (idempotent POSTs) and `GET .../contact`. Lender A cannot see lender B's rows (API check and forced RLS).

- **Checks:** status only (`not_started`, `in_progress`, `completed`, `failed`) for `kyc`, `bureau`, `account_aggregator`. No documents, identifiers, reports or scores are accepted or stored.
- **Decision:** `pending`, `processing`, `info_needed`, `declined`, `approved`. Recorded as reported. A decision after the response deadline is stored with `late: true`, `applied: false` (D-40).
- **Offer:** requires a recorded approval; values are stored exactly as sent; the KFS link must be https on a host registered for the lender; validity must be at least the lender's minimum (default 7 days). A failing submission is returned as `held` with issue codes and is never shown to the borrower. Re-sending a reference creates a new revision.
- **Contact:** returns the phone number once per call, only while consent stands, audited without the number, `Cache-Control: no-store`.

## Platform routes (platform staff; two-person change control)

`GET /v1/platform/lender-connectors`, `PUT /v1/platform/lenders/{id}/connector` (kind `manual` or `api`, status,
response hours, minimum offer validity, KFS hosts, signing-secret _name_), `GET|POST /v1/platform/matching-rules` and
`POST .../{id}/decision` (a different administrator must approve; self-approval is refused).

## Signed callbacks from a lender's system

Served by a **separate process** (`pnpm --filter @udofin/api callbacks`, needs `SYSTEM_DATABASE_URL`), never by the public API:
`POST /v1/hooks/lenders/{lenderId}` with `webhook-id`, `webhook-timestamp`, `webhook-signature`.

- Unknown, inactive or manual lenders: `404`, indistinguishable.
- `api` connectors: `503 callback_scheme_not_configured` until a lender specification exists (D-43). Nothing is accepted unauthenticated.
- The only implemented scheme is the labelled **mock** (`mock-standard-webhooks-v1`): HMAC-SHA256 over `id.timestamp.body`, 5-minute window, timing-safe comparison. It is refused in staging and production (`503 mock_connector_blocked`). It is not a production protocol.
- A valid signature is followed by database checks: message-id de-duplication, lender/application matching, lifecycle rules. Outcomes: `applied`, `duplicate`, `rejected`, `quarantined`. A rejected message changes nothing and is recorded.
- Secrets are referenced by _name_ (an environment variable set by the deployment); values never enter the repository or logs.
