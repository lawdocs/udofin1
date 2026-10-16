# Phase 08a: what must be true before a lender is switched on

Status: written 16 October 2026 with the Phase 08a build. **Nothing here is activated for any lender.** Every switch in
`servicing.lender_features` is off by default, and a row can say `enabled = true` only through a two-person request that the
database checks against the conditions below. `collections` and `dlg` can never be enabled by any row (Phase 08b and 08c are not
built and need the owner's separate approval).

Two kinds of condition exist. The **database conditions** are enforced by `private.feature_prerequisites_unmet` (the reason codes
are the exact strings it returns, and they are shown to the platform user who decides the request). The **outside conditions** are
things the database cannot check: contracts, evidence, keys, legal reading. They are listed so the owner can see what is still
missing; none is assumed.

A mock or sandbox payment configuration can never satisfy a database condition, whatever the session settings are
(`private.provider_mode_satisfies_production_gate`). A mock never runs in staging or production: three layers refuse it
(configuration, `assertProviderAllowed` / `assertLocalOrTestOnly` in the adapters, `udofin.allow_mock_providers` in the database).

## Every feature

| Database condition (reason code)                                                                                      | Meaning                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `feature_unknown`, `feature_not_enableable`                                                                           | The feature is in the catalogue and is enableable (collections and dlg never) |
| `lender_organisation_not_active`, `onboarding_gate_not_activated`                                                     | The lender is an active organisation whose onboarding gate is activated       |
| `evidence_missing`                                                                                                    | The pending request carries evidence (labels and references, never documents) |
| A different platform person approves than the one who requested it. Turning a feature off is deliberately one person. | Two-person control to enable (ADR 0025); `servicing.kill_feature` to disable  |

## `servicing_sync` (balances, schedule, receipts from the lender)

- Database: `lms_connection_not_active`: an **active** file-import or manual LMS connection in production mode. A mock connection never
  counts; a connector for Finbyx or a generic REST system can exist only as `blocked_unverified` because no specification exists.
- Outside: the lender's agreement on the import file (format `udofin-lms-import-v1`), who may upload it, and how often. The LMS
  of MGM Financiers and Megapode Vyapar is **not confirmed** (owner decision 4).

## `statements_noc` (statement requests, foreclosure quotations, no-dues letters, security release)

- Database: `servicing_sync_not_enabled`.
- Outside: a production document store with per-lender keys (D-06, D-47) so that lender-issued documents can be stored and served
  outside local development; the lender's own issuing process; the NOC and statement deadlines (no deadline for unsecured loans is
  confirmed; an approved applicability rule is data and none is approved, so due dates stay empty and are shown as "not set").

## `reminders` (in-app and push service messages)

- Database: `servicing_sync_not_enabled`; `reminder_policy_missing` (an approved policy); `reminder_templates_missing` (an approved
  English wording for each of pre-due, due-day and overdue).
- Deliberately **not** a database condition: an approved penal-charge text. Without it, overdue reminders are suppressed (`penal_text_missing`)
  and the lender is told; Udofin never invents, calculates or generates a charge sentence.
- Outside: the lender's approved wording and (if it wants Hindi) approved Hindi wording; approval of the platform defaults for the window
  (08:00 to 19:00 IST, our reading of RBC para 100, **interpretation**), the daily cap of two and the 48-hour quiet period after a
  payment (**unverified** product defaults); a push provider (none exists: push answers `not_configured` outside local and test). No SMS
  provider or DLT registration exists and none is assumed (D-35, D-72); SMS rows are inert placeholders that can never be sent.

## `payments` (one-time payments to the lender's own account)

- Database: `payment_config_missing` (an **active** payment configuration in production mode); `payment_config_mock_or_sandbox_only`;
  `registry_entry_not_verified` (the lender's settlement account is linked to a **verified** registry entry); `payment_config_validation_failed`
  (the collection-target validation: the lender's own, verified, permitted for repayment settlement, masked reference consistent,
  merchant the lender's own and verified at that provider, provider approved).
- Outside, all of them currently missing:
  1. A payment provider, contracted by the **lender** as merchant of record, settling into the lender's own account (D-65, ADR 0008).
     No provider is approved; only the labelled mock and an unconfigured placeholder exist. No real provider adapter has been written.
  2. The provider's written specification: webhook scheme and signing, status vocabulary and ranks, settlement report, cut-off times,
     refund and chargeback handling. Until a scheme exists the callback receiver answers every delivery with the uniform refusal.
  3. The lender's verified account and merchant details entered by a platform user in the registry (no account details are seeded;
     the account-number length rule 9 to 18 digits is configuration, **unverified** until its source is supplied).
  4. Hand-off link keys in a secrets manager (`HANDOFF_ENCRYPTION_KEYS`, `HANDOFF_ACTIVE_KEY_VERSION`) for the worker and the API; the
     fingerprint key in a managed key store (D-47: only a local development key manager exists).
  5. The callback URL configured at the provider with the opaque endpoint token the draft configuration returned once; the
     address-hash key `PROVIDER_HOOK_IP_HMAC_KEY` for the receiver.
  6. The lender's agreement to carry Udofin's payment reference (or the intent id) in the receipt it posts (D-69): without it every
     payment shows "received by the payment provider" and never "posted by the lender", and reconciliation raises `lender_receipt_missing`.
  7. Counsel's reading of the points in the spec section 24 (payment-aggregator rules, e-mandate framework, penal-charge disclosure).

## `mandates` (repayment mandates with the lender as creditor)

- Database: everything `payments` needs, plus `provider_not_mandate_capable` (the provider is registered as mandate or payment-and-mandate
  and approved), `mandate_rail_not_configured` (rail limits **copied from the provider's documentation** into the configuration:
  maximum amount per rail and whether authentication may be needed on every debit), `mandate_policy_missing` (the lender's own settings),
  `servicing_sync_not_enabled`.
- Outside: a mandate rail and sponsor-bank or utility arrangement for the lender (D-66); the provider's return-code list classified
  with evidence (`payments.set_return_code_class`; nothing is seeded); the NPCI and RBI e-mandate texts (not on file, **unverified**);
  whether the issuer's own 24-hour pre-debit notice replaces ours (**unverified**; the lead time is a lender setting, 24 to 168 hours,
  default 48); a borrower bank-account verification (none exists in the repository, so "a changed verified account cancels the mandate"
  is **not implemented**); the device-integrity tier (`device` or `strong`) chosen for mandate creation is ours, not a recorded owner decision.

## Reconciliation (not a switch: it runs for every lender with a payment configuration)

- Needs, per lender, any of: the provider's settlement report (fetched by the worker through the provider port, or an uploaded file),
  the lender's bank credits (date, amount and bank reference only, uploaded by the lender), and the lender's LMS receipts. A missing
  input is shown as "not reconcilable", never as "reconciled".
- The waiting times (three days for the provider and the bank, 72 hours for the lender to post) are **unverified defaults with no
  source**; replace them from the provider and lender agreements.
- The roadmap gate "Udofin holds no borrower funds" is evidenced by the standing line `settled_to_non_lender` of the run report:
  **zero is the evidence**; any non-zero value is a critical finding.

## `collections` and `dlg`

Not built and not enableable. Collections needs counsel's review of conduct, the unread 6 August 2026 recovery amendment, lender mandates
and the agent register (D-76 to D-78). The DLG ledger needs counsel, the capital model, cover instruments and the auditor's declaration
(D-79). The owner's approval of Phase 08a is not approval to start either.

## Missing-texts register (owner decision 6)

Not on file and therefore not used as fact: RBI Digital Payments e-Mandate Framework 2026; RBI Master Direction on Payment Aggregators
(15 Sep 2025); NPCI UPI AutoPay circulars and the NACH and API e-Mandate procedural guidelines; TRAI TCCCPR with the February 2025 amendment
and the 1600-series direction; the RBC Second Amendment (15 Jun 2026) and the recovery Third Amendment (6 Aug 2026); the RBI pre-payment
charges directions and the September 2023 document-release circular; the first amendment of the credit-information directions; any bank,
urban co-operative bank or housing-finance instrument (D-31). Their later arrival is not evidence of anything until they are read.
