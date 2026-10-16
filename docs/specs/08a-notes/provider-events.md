# Provider events, payments and the exception queue (migration 20261018000913)

Interface notes for the API, worker and callback-receiver work. Spec: `docs/specs/08-servicing-payments-mandates-collections.md` sections 7.2, 7.3, 9 and 10. Tests: `supabase/tests/019_p08a_provider_events_payments.test.sql`.

## The three stores (owner decision 2)

| Store                              | What it holds                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments.webhook_receipts`        | One row per inbound delivery, whatever the outcome: `verified`, `verified_ignored`, `duplicate`, `unverified`, `stale_timestamp`, `unmatched`, `invalid`, `scheme_not_configured`, with a closed reason class, the payload SHA-256, scheme name, whether a signature was present, timestamp skew, body size and a keyed address hash. No body, signature, header, token or personal data. |
| `payments.provider_events`         | VERIFIED events only (check `signature_verified`). Authenticated, integrity-checked, correlated and business-valid. Unique `(provider, provider_event_id)`. Append-only. An authentic event of an unsupported kind or an unmapped status is stored here with `processing_class = 'ignored'`.                                                                                              |
| `ops.seen_webhooks` (replay store) | The delivery id, consumed ONLY after verification, correlation and business validation succeed, so a forged or unmatched delivery cannot reserve a genuine delivery id or event id.                                                                                                                                                                                                       |

## `payments.ingest_provider_delivery(p_token_hash text, p_delivery jsonb) returns jsonb` (system role only)

The callback receiver hashes the endpoint token (SHA-256, hex), runs the provider's `WebhookVerifier` over the raw body and calls this once per delivery. `p_delivery`:

```
{ provider, outcome: verified|unverified|stale_timestamp|invalid, reason_class, delivery_id, payload_sha256,
  scheme, signature_present, timestamp_skew_seconds, body_bytes, ip_hmac,
  event: { provider, deliveryId, eventId, objectKind, objectRef, orderRef, status, rank, amountMinor (digit string), currency, occurredAt, merchantRef } }
```

`event` is present only for `verified`. The answer is `{accepted, outcome}`:

- `{true, ok}`: stored (verified, verified_ignored, or an acknowledged duplicate). HTTP 200.
- `{false, rejected}`: unknown / suspended / retired token, bad signature, stale, invalid, scheme not configured, provider mismatch. The receiver answers all of these identically (no enumeration).
- `{false, unmatched}`: authentic but no intent of THIS lender, provider and configuration has that order reference yet (the provider will retry; the delivery id was not consumed). HTTP 409.
- `{false, invalid}`: authentic but not business-valid (money status without an amount, wrong currency, malformed field). HTTP 422.

Order of checks (the order matters): route by token to an ACTIVE configuration; provider equals the configuration's; non-verified outcome gives a receipt and stops; read and validate the event; merchant named by the provider must equal the configuration's merchant (a mismatch suspends the configuration and opens a critical platform exception); unsupported kind or unmapped status is stored verified-and-ignored; correlation (payment, refund, chargeback by order reference; mandate and debit through `private.correlate_mandate_event`); business validation; ONLY THEN `private.mark_webhook_seen`; then the event row (a repeated event id with a different payload hash opens an `event_payload_conflict` exception); then the receipt; then, for actionable events, the outbox event `payment.apply_event` (ids only, dedupe key `payment.apply_event:<event id>:1`).

Receiver duties that the database cannot do: constant-time signature check over the raw body, size and content-type limits, rate limits per address and token, the keyed address hash (`ip_hmac`, the raw address is never sent), no logging of bodies or headers.

## `payments.apply_provider_event(p_event uuid) returns jsonb` (system role only, the worker)

Idempotent. Concurrency: an advisory lock on the event id plus the intent row lock, so concurrent identical applications yield exactly one application; the loser sees the finished `event_processing` row and answers `already_applied`. Outcomes (`payments.event_processing`, append-only): `applied`, `already_applied`, `ignored_stale`, `deferred` (with `deferred_until`; the function enqueues the retry itself), `exception`, `ignored_unsupported`, `ignored_unsupported_yet`, `recorded_for_reconciliation`. Rules:

- payment events upsert `payments.provider_payments` (unique `(provider, provider_payment_ref)`): only a higher rank moves a row; a lower rank is `ignored_stale`; a failure after a success opens `payment_status_conflict` and never reverts anything. A failed payment ATTEMPT never fails the intent (the customer may retry on the same order); the intent leaves `pending` only by a success, by `expire_stale_intents`, or by `record_order_failed`.
- the intent becomes `succeeded` only through the existing guard (a verified event, same intent, lender and provider, a status in `private.payment_success_statuses()`, equal amount and currency). A different amount keeps it `pending` and opens `amount_mismatch`; a second capture is a separate row with `duplicate_capture = true` and a `duplicate_payment` exception; money on an intent that is no longer open opens `payment_on_closed_intent`.
- `refund` (status `refunded`) and `chargeback` (status `disputed`) become rows in `payments.payment_adjustments` (positive, one per provider object, referencing the provider payment and the event). A refund seen before its capture is deferred (backoff 2, 4, 8 ... minutes, six attempts), then `refund_unmatched`. Adjustments above the captured amount are stored and open `amount_mismatch`. The intent row is never edited.
- settlement events are `recorded_for_reconciliation`; mandate and debit events call `private.apply_mandate_event` (the mandates migration replaces it; until then `ignored_unsupported_yet`).

## The borrower request and the order lifecycle

`payments.request_payment(p_loan, p_purpose, p_amount_minor, p_idempotency_key, p_quote default null) returns uuid` is the ONLY way an intent is created (borrowers and the system role have no INSERT on `payment_intents`). Errors (SQLSTATE|hint): `55000|feature_disabled`, `55000|loan_not_active`, `55000|collection_target_invalid`, `55000|config_ambiguous`, `55000|figures_unavailable`, `55000|stale_data`, `55000|nothing_due`, `55000|purpose_not_supported` (charges), `55000|purpose_not_enabled`, `55000|quote_required`, `55000|quote_not_current`, `55000|quote_flagged`, `22023|amount_not_allowed`, `22023|bad_request`, `23505|idempotency_conflict`, `23505|open_intent_exists`, `P0002` (loan not found or not the borrower's). Amount rules come from the lender's REPORTED figures (`private.servicing_borrower_loans`) and `payments.lender_payment_policies` (`payments.set_payment_policy`, `payment.configure`, aal2): exact figure by default; a smaller part only when the lender enabled it. The `payments`, `servicing_sync` and (for foreclosure) `statements_noc` switches must be on.

System functions for the worker: `payments.record_order_created(intent, provider_order_ref, link_expires_at)` (created to pending), `payments.record_order_failed(intent, reason_class)` (reason classes `provider_rejected`, `provider_unavailable`, `merchant_mismatch`, `invalid_request`; `merchant_mismatch` also suspends the configuration and opens a critical platform exception), `payments.expire_stale_intents(grace)` (intents past their link expiry and grace, with no provider payment on file). The worker must look the order up at the provider before expiring or retrying (a timeout is an unknown outcome, never a blind re-creation).

`payments.my_payment(intent)` gives the borrower an honest stage (`started`, `provider_received`, `lender_posted`, `needs_attention`) derived only from verified provider payments and the lender's own receipts (a receipt counts when it carries the provider payment reference or the intent id in `bank_reference`, for the same amount, and has not been reversed). No function accepts a success flag.

## Exceptions

`payments.reconciliation_exceptions` (class from a closed list, severity, owner lender|platform, status open/acknowledged/assigned/resolved/reopened, ids-only subject; one open exception per lender, class and subject) with append-only `reconciliation_exception_events`. `payments.raise_exception` (system), `acknowledge_exception`, `assign_exception`, `resolve_exception(id, reason_code, evidence jsonb, note)`, `reopen_exception` (people). Lender-owned exceptions need `payment.reconcile` in that lender; platform-owned ones (`merchant_mismatch`, `event_payload_conflict`, `settlement_account_mismatch`) need `platform.payments.providers.manage`. Resolution needs a closed-list reason and evidence (1 to 10 ids or labels, letters, digits and `. _ : / # -` only) and changes nothing else.

## Not done here (later in Phase 08a)

- Reconciliation runs, settlement batches and items, bank credits and the derived settlement stages (reconciliation migration).
- Mandates (`private.correlate_mandate_event` and `private.apply_mandate_event` are the hooks to replace).
- The HTTP receiver route, the worker handlers for `payment.create_order` and `payment.apply_event`, API routes and contracts.
- A two-connection concurrency test of `apply_provider_event` (the API stream adds it; the single-session tests cover idempotency).
