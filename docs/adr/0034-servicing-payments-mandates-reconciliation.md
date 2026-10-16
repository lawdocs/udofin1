# ADR 0034: Servicing, payments, mandates and reconciliation (Phase 08a)

Date: 2026-10-16. Status: proposed for owner approval (Phase 08a). Related: ADR 0007, 0008, 0009, 0013, 0019, 0023, 0025, 0027, 0032, 0033, 0035.

## Context

After disbursal the lender's loan system stays the only record of what the borrower owes (ADR 0007), and the borrower pays the
lender directly, never through an account of Udofin (ADR 0008, RBI Credit Facilities Ch. III para 10). Phase 08a gives the borrower
and the lender a view of that record, a way to pay and to set up a repayment mandate, and gives everyone a way to check that the
money went where it should. The owner's decisions of 14 October 2026 (spec section "Owner decisions") bind: only 08a is authorised,
collections and DLG stay off, verified events and unverified receipts are separate, the account registry is fail-closed, no LMS is
assumed, reminders are in-app and push only, and nothing awaiting a document, contract or provider is activated.

## Decisions

1. **Copy, never compute.** `servicing.balance_snapshots`, `schedule_snapshots`, `lms_receipts` and the lender-issued documents are
   append-only copies of what the lender reported, with source lender, source system, import batch, source record id and the
   lender's own timestamp. A report that disagrees with an earlier one is queued as a conflict (or an anomaly) and never overwrites
   anything. Udofin allocates no receipt, computes no balance, penal charge or foreclosure amount, and shows the borrower "as
   reported by the lender at <time>" with a stale flag. Figures are withheld (not zeroed) when the newest report is flagged or a
   conflict about the loan report is open.
2. **Import first, behind one door.** `servicing.apply_lms_report` is the only implementation of a lender report, used by the
   file/manual import (all-or-nothing, row errors without values), by the labelled mock, and by a future connector. No REST
   connector is a dependency.
3. **Three stores for provider deliveries.** `payments.webhook_receipts` (every delivery, any outcome, no body), `provider_events`
   (verified events only, a check on `signature_verified`) and the replay store `ops.seen_webhooks`, consumed only after
   authentication, correlation and business validation, so a forged or unmatched delivery cannot reserve a genuine id. An authentic
   event of an unsupported kind is stored verified-and-ignored.
4. **A payment moves only on a verified event.** `payments.request_payment` is the only way to create an intent (amounts come from
   the lender's reported figures and the lender's policy); the intent becomes `succeeded` only through the existing guard (verified
   event, same intent, lender and provider, a success status, equal amount). Refunds and chargebacks are compensating rows; the
   intent is never edited. A redirect, a client flag or a screen can never move a stage; `payments.my_payment` and
   `payments.payment_stages` derive stages from verified events, the lender's receipts, the provider's settlement report and the
   lender's bank credits.
5. **Fail-closed accounts and configuration.** A payment configuration activates only if its settlement account is the lender's own,
   verified, permitted for repayment settlement and consistent with the keyed fingerprint registry, and its merchant is the
   lender's own verified merchant at the provider. It is revalidated nightly and after a registry change; a provider that reports
   settlement to a different account, or a different merchant, suspends the configuration at once and opens a critical exception
   for the platform. No account details are seeded; the account-number length rule is data, `unverified` until sourced.
6. **Mandates have the lender as creditor and the system as the only actor.** Every lifecycle move is made by the system on a
   verified event or an authenticated lookup; the borrower can request a draft (bound to a step-up code for that mandate id and a
   device-integrity tier) and request cancellation, which is a request until the provider confirms. Udofin plans expected debits
   from the lender's reported schedule for the pre-debit notice; it does not present debits. A returned debit creates no Udofin
   charge. A rail with no limits copied from the provider's documentation is `rail_not_configured`: nothing is assumed.
7. **Reconciliation is exact and writes no money.** Provider payments, provider settlement items, the lender's bank credits (value
   date, amount and bank reference only) and the lender's LMS receipts are matched to the paisa, with time as the only tolerance
   (labelled, unverified defaults). A missing input is "not reconcilable", never "reconciled". Differences become exceptions worked
   by named people; a resolution is an annotation, not a correction.
8. **Reminders are service messages.** In-app and push only (SMS rows are inert placeholders that can never be sent), a window of
   08:00 to 19:00 IST at most, a daily cap, a quiet period after a payment, per-loan holds, wording and penal-charge text approved
   by a second person, content frozen at claim with hashes, and an overdue reminder sent only with the lender's approved
   penal-charge sentence verbatim. Delivery is recorded only from a delivery report.
9. **Switches fail closed.** `servicing.lender_features` is off unless a two-person request is applied; collections and DLG can
   never be enabled by any row; every activation reason (missing configuration, mock-only configuration, unverified registry entry,
   missing provider capability) is evaluated by `private.feature_prerequisites_unmet`.
10. **Mocks are labelled and blocked.** Three layers: configuration, the `assertProviderAllowed` / `assertLocalOrTestOnly`
    guards in the adapters, and the `udofin.allow_mock_providers` guard in the database. A mock or sandbox configuration can never
    satisfy an activation gate.
11. **Errors carry stable codes.** Database refusals carry SQLSTATE and a rule hint; the API maps every hint to a stable problem
    code and never echoes request data.

## Consequences / revisit

- Real payments need, before any lender is switched on: a payment provider and mandate rail documented and contracted (D-65/D-66),
  the lender's merchant and settlement-account evidence in the registry, rail limits and return-code classes copied from the
  provider's documentation, settlement lag and cut-off times (D-68/D-69), the lender's agreement to carry Udofin's payment
  reference in the receipt it posts (D-69), and counsel's sign-off on the matters in spec section 24. None is assumed here.
- No SQL function applies an authenticated order lookup as evidence of payment (an authenticated lookup has the standing of a
  verified event in the adapters, but the database accepts only verified events). The worker therefore never expires an intent whose
  lookup shows success; it opens an exception for a person. Revisit when a provider is selected.
- A borrower bank-account verification does not exist in the repository (Phase 07 stored none), so a mandate stores only the masked
  reference the borrower supplied and the bank's authorisation step is the only proof of ownership; "a changed verified account
  cancels the mandate" is not implemented.
- Whether the issuer's own 24-hour pre-debit notice removes Udofin's duty to send one is unverified; the lead time is a lender
  setting (24 to 168 hours, default 48).
- Collections (08b) and the DLG ledger (08c) are not built.
