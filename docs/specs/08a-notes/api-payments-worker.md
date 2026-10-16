# Phase 08a notes: payments and mandates WORKER (builder w1)

The worker side of payments and mandates: four outbox handlers, the provider resolver and a processor over the system SQL functions. No HTTP route lives here (the borrower and lender routes are other builders'). Nothing in this note claims regulatory compliance: it describes what the code does and what it does not.

Code: `services/api/src/workers/payments-handlers.ts`, `services/api/src/workers/provider-resolver.ts`, `services/api/src/system/payments.ts`. Tests: `services/api/test/payments-worker.test.ts` (unit, no database) and `services/api/test/integration/payments-worker.integration.test.ts` (real migrated Postgres, real outbox worker, labelled mocks).

## What the code does and does not decide

The handlers pass ids and the provider's answer to the database and map the result. They compute no amount, derive no stage and decide no eligibility. They do make these narrow, fail-closed decisions that are not in the database, listed so a reviewer can challenge each:

| Decision                                                                                                                                      | Where                           | Why it is here and not in SQL                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No provider is called for an intent that is not `created`, or whose payment period is already over                                            | `createOrder`                   | The database cannot stop a provider call that has not happened. The status check is what makes a repeated delivery harmless. The period check leaves the closing to `payments.expire_stale_intents`. |
| No provider is called under a configuration that is not `active` (suspended by the kill switch or a mismatch)                                 | `createOrder`, `handOffMandate` | Fail closed: a suspended configuration must not take new orders. A cancellation request is the one exception: it lowers risk, so it is sent under any configuration.                                 |
| The merchant the provider names must equal the configured one; a missing merchant counts as a mismatch                                        | `recordOrder`                   | The spec's binding back (7.1 point 5). The consequences (intent failed, configuration suspended, critical exception) are the database's, in `record_order_failed('merchant_mismatch')`.              |
| Link expiry kept for the vault: provider expiry, else intent expiry, else 60 minutes (payment) or 24 hours (mandate); never more than 30 days | `linkExpiry`, `orderExpiry`     | The vault needs an expiry and the provider may send none. 30 days is below the database limit of 31. These constants are not regulatory figures.                                                     |

## Handlers

All four are registered by `createPaymentsHandlers(deps)` and run under the outbox worker (at-least-once; every handler is safe to run twice). Authentication is the system login (`service_role`) that the worker already holds; there is no permission check because no person is involved. Payloads are `z.strictObject` and carry one id.

| Outbox type            | Payload        | SQL functions called (system role)                                                                                                              | Permanent failures (event goes dead)           | Retried (outbox backoff, 8 attempts)                                               |
| ---------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `payment.create_order` | `{intent_id}`  | select on `payment_intents`, `lender_payment_configs`, `merchant_registry`; `record_order_created`; `record_order_failed`; `store_handoff_link` | `invalid_payload`, `intent_not_found` (P0002)  | database or connection errors; `OrderOutcomeUnresolved` (see below)                |
| `payment.apply_event`  | `{event_id}`   | `apply_provider_event`                                                                                                                          | `invalid_payload`, `event_not_found` (P0002)   | every other database error                                                         |
| `mandate.handoff`      | `{mandate_id}` | select on `mandates` and the configuration; `record_mandate_handoff`; `store_handoff_link`                                                      | `invalid_payload`, `mandate_not_found` (P0002) | database or connection errors (the guard `mock_provider_blocked` is one, see gaps) |
| `mandate.cancel`       | `{mandate_id}` | select on `mandates` and the configuration; `mark_mandate_cancel_sent`                                                                          | `invalid_payload`, `mandate_not_found` (P0002) | database or connection errors                                                      |

### `payment.create_order`

1. Load the intent with its configuration and merchant (one read). Unknown: permanent. Not `created` (cancelled, expired, failed, pending, succeeded): nothing. Payment period over: nothing (the sweep expires it).
2. No configuration, or not `active`, or no provider can be resolved, or the purpose is unknown to the port: `record_order_failed(intent, 'provider_unavailable')` (`'invalid_request'` for the purpose). No provider call.
3. `createOrder` through `withPaymentTimeout` with `operationKey = receiptRef = intent id`, the configured merchant, the intent's amount (bigint paise), purpose and link expiry.
4. Answers:
   - `ok`: merchant differs or is missing: `record_order_failed('merchant_mismatch')`, stop. Otherwise `record_order_created(intent, orderRef, expiry)`, then (with a keyring and a link) `sealHandoffLink` (kind `payment_intent`, subject = intent id, lender) and `store_handoff_link`. No keyring or no link: the order stands without one and the log says only that no link was kept.
   - `rejected`: `invalid_request` stays `invalid_request`; `unsupported_currency` becomes `provider_rejected`.
   - `unsupported`, `not_configured`: `provider_unavailable`.
   - `unknown` (timeout, network, 5xx) and the meaningless `not_found`: NOT created again blindly. `getOrderStatus` by operation key. Found: the merchant is checked and `record_order_created` is called with the looked-up order reference and no expiry; no link exists then (the log says so). Not found, unknown or refused: `OrderOutcomeUnresolvedError` (the outbox backs off and the create call repeats under the same operation key, which the provider treats as the same order); on the last attempt (`attempts >= max_attempts`) `record_order_failed('provider_unavailable')` and the event completes.
5. Database answers handled: `order_ref_invalid` and `link_expiry_invalid` (22023) fail the intent as `provider_unavailable` (the provider's answer is unusable); `intent_state_invalid` (55000, the borrower cancelled meanwhile) ends the run quietly and leaves the order unused.

### `payment.apply_event`

`apply_provider_event(event)`; every outcome word (`applied`, `already_applied`, `ignored_stale`, `deferred`, `exception`, `ignored_unsupported`, `recorded_for_reconciliation`) is a normal result and is logged with its reason class. P0002 is permanent. The function is idempotent in the database (advisory lock plus the intent row lock), so a replay logs `already_applied`.

### `mandate.handoff`

Loads the mandate. Not a draft: nothing. A draft whose cancellation the borrower already requested: nothing (the sweep closes it). Then `createMandateRequest` through `withMandateTimeout` (`operationKey` = mandate id, rail, the mandate's `creditor_ref`, maximum, INR, dates, masked account reference).

| Provider answer                                                                                     | Recorded                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                                                                                                | `record_mandate_handoff('handoff', ref, expiry)` FIRST (draft to `registration_pending`), then seal and `store_handoff_link` (kind `mandate`). NOT active. |
| `ok` but the database refuses the reference (`bad_request`)                                         | `record_mandate_handoff('unknown')`: the provider may have registered something we cannot match later.                                                     |
| `rejected`                                                                                          | `'rejected'` (draft to `failed`)                                                                                                                           |
| `unknown`, and the meaningless `not_found`                                                          | `'unknown'` (to `requires_reconciliation`, platform exception). Never retried without a lookup.                                                            |
| `unsupported`, `not_configured`, no configuration, configuration not active, no provider resolvable | `'rejected'`, because nothing was sent. See the gap below: the database has no word for this.                                                              |

### `mandate.cancel`

Sends only if a cancellation was requested, not yet sent, the mandate is still live (`MANDATE_LIVE_STATUSES` of `@udofin/domain`) and the provider has a reference for it. `cancelMandate` through `withMandateTimeout`; only an `ok` acknowledgement calls `mark_mandate_cancel_sent`. The mandate is NOT cancelled by this: it changes only on a verified event or a status lookup. Unknown, unconfigured, refused, not found, no reference, no usable provider: not marked sent, the event completes, and `payments.sweep_mandates` reports the unconfirmed cancellation.

## Provider resolver

`createProviderResolver(deps)` keeps the exported types and signature that the scaffold fixed. `createProviderResolverWith(deps, adapters)` is the same with the real-adapter registry supplied; production uses the empty one.

| Environment             | `mock` configuration                                                                           | `sandbox` / `live` configuration                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `local`, `test`         | the labelled mock (one instance per configuration, so retries meet the same scripted provider) | the unconfigured placeholder: every call answers `not_configured` |
| `staging`, `production` | `{ ok: false, reason: 'mock_not_allowed_here' }`                                               | the unconfigured placeholder                                      |

A configuration that names no provider or an unknown mode gives `provider_not_configured`. A real adapter (none exists; the registry is empty) would be built from a secret read by NAME (`secretRef`); a missing or empty secret gives `secret_missing`, a factory that throws gives `provider_not_configured`, and the secret value never appears in a result, an error or a log. The unit tests prove these rules with a fake adapter, so they cannot be skipped when a real one is added.

`contextFor(correlationId, idempotencyKey?)` builds `{ tenantId: <lender>, correlationId, idempotencyKey? }`. The database mode `production` is called `live` here (mapped in `system/payments.ts`).

## Hand-off links

The provider's link is a bearer secret. It is sealed in the worker (`sealHandoffLink`, AES-256-GCM, associated data names kind, subject and lender) and only ciphertext reaches `payments.store_handoff_link`. The integration test shows, against the real database: the stored bytes hold no part of the link; the owning borrower's `take_handoff_link` returns ciphertext that opens, with the keyring, to exactly the link the provider returned; another borrower and anon get `P0002 link_unavailable` and `42501`; the blob does not open under another lender or subject; an inactive lender hides it; the audit event names the key version only. Logs carry ids and closed words, never a link, a provider reference, a merchant, a masked account or a secret (a canary test scans every log line and the outbox, audit, intents, mandates, exceptions and vault rows).

## Not built, deviations and open gaps (honest list)

1. **Resolved by migration 918: a hand-off that was never sent has its own outcome.** `record_mandate_handoff` now also knows `not_sent` (no configuration, an inactive configuration, no resolvable provider, a rail the provider cannot carry): the draft fails with the system as the source and no exception, while a provider's own refusal stays `rejected` with the source `handoff`. The handler uses `not_sent` for the first group and `rejected` only for the provider's answer. (The earlier text of this item said the history read "failed after hand-off" for both.)
2. **A lost link is not self-healing.** If the process dies, or the vault write fails, after `record_order_created` / `record_mandate_handoff` succeeded, the order or mandate stands without a stored link. A repeated delivery finds the intent `pending` (or the mandate `registration_pending`) and does nothing, as designed, and the system role cannot read `payments.handoff_links` to notice the gap. The borrower is told honestly that no link is available (`take_handoff_link` answers `link_unavailable`); a payment link then expires on its own, and a mandate stays `registration_pending` until a verified event or the periodic lookup (`mandates_needing_lookup`) settles it. A failed vault write is logged by SQLSTATE and hint and does not fail the event, because retrying could not help. Suggested: a system-only function that lists pending intents and registration-pending mandates without a stored link, for the periodic job to re-ask the provider (the operation key makes the repeat the same order).
3. **The mock-provider database guard fires on every update of a mock mandate** (`payments.mandates` trigger `guard`, `before insert or update`), unlike the configuration trigger, which fires on `update of provider_mode`. A worker whose session does not allow mock providers fails with `42501 mock_provider_blocked` at `record_mandate_handoff` (retried, never succeeds). In local development and tests the system login must therefore start with `udofin.allow_mock_providers=on` (`PGOPTIONS='-c udofin.allow_mock_providers=on'` or a connection option); the integration test does it with a connection option and proves the guard with a second pool. Staging and production must leave it unset (a mock configuration cannot exist there).
4. **`main.ts` does not pass a logger.** The handlers default to one JSON line per message on stdout, in the same shape as the worker's own logger. Wiring `log` is a one-word change (see the shared-file requests).
5. **A provider that does not state a merchant cannot satisfy the binding** and is treated as a mismatch (which suspends the configuration). This is the fail-closed reading of the spec; it needs an owner decision when a real adapter is specified (an adapter may be able to prove the merchant another way).
6. **A looked-up order is recorded whatever status the provider reports.** The lookup path records `pending` even if the provider says the order failed or expired; later verified events or lookups (periodic jobs, builder w2) and the expiry sweep correct it. The handler does not interpret provider statuses.
7. **The worker does not re-check the lender's activation switches at processing time.** `request_payment` and `request_mandate` check them when the borrower asks, and `take_handoff_link` hides the link when a switch or the lender is off (tested), so an order created after the switch went off cannot be paid through Udofin, but it does exist at the provider.
8. **`mandate.cancel` with an unknown outcome is not retried and not looked up.** It relies on the sweep (`mandate_cancel_unconfirmed` after the grace period) and on the periodic lookup job (`mandates_needing_lookup`, builder w2), as the brief says. A retry would be safe (the operation key is the mandate id) but the port contract says look up first, and the lookup belongs to the periodic job.
9. **`apply_provider_event` errors other than P0002 are retried** (for example `55000 event_not_correlated`), so a deterministic refusal reaches `dead` after the attempts instead of at once. Visible, but slower than a permanent failure.
10. **The payment purpose `cooling_off_exit` exists in the port but not in the database enum**, so no intent can carry it. Not an error here.
11. **Mocks keep state in memory per configuration** (orders, requests, lookups) for the life of the worker process. Local development and tests only; they are refused elsewhere.
12. **No real adapter, no settlement report fetching, no debit status polling, no lookups of order or mandate status** are built here: they are the periodic jobs (builder w2). `cooling_off_exit` and debit presentation are not built anywhere, by decision.
13. **Timeouts:** 15 seconds per provider call by default (`providerTimeoutMs`), against the outbox lease of 60 seconds and at most two provider calls per handler run. A value to review once a real provider's behaviour is known.

## Test evidence

Run on a freshly migrated database; the real counts are in the builder's report. Guards proven by removing them on purpose (each made at least one test fail, then restored): intent status check, configuration-active check, merchant binding, mandate draft check, cancel-requested draft check, cancellation marked sent without an acknowledgement, link stored unsealed, loosened payload schema, merchant mismatch recorded under another class, mock allowed in every environment, retry without a lookup, sandbox/live resolved to the mock.
