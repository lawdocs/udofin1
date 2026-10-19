# Phase 08a API: servicing, payments, mandates, reconciliation, reminders

Status: generated from [`openapi.json`](openapi.json) on 16 October 2026 (the route table below is regenerated when the OpenAPI document is). The conventions in [`README.md`](README.md) apply to every route: problem+json errors with a stable `code`, `Idempotency-Key` on every state-changing POST, keyset pagination, strict request bodies, responses validated against their declared schema. Nothing here says a feature is switched on: every Phase 08a feature is off for every lender until a two-person request that the database checks (`docs/operations/phase-08a-activation-gates.md`).

How a client should read it:

- **Money** is integer paise (`Paise`, 0 to 10^14) on the wire; dates are `YYYY-MM-DD`; timestamps carry an offset.
- **Figures the lender reported** carry `reportedAsOf` and a `stale` flag; when the lender's figures are withheld the amounts are `null`, never zero.
- **A payment is "received by the payment provider" until the lender posts it**; the client never infers "paid" from a redirect.
- **The payment and mandate hand-off link** is fetched with `GET .../link` (no-store, tight rate limit, never logged) and exists only while the subject is open; a missing key configuration answers `503 handoff_unavailable`.
- **Idempotency keys** of payment and mandate requests must be random (16 to 128 characters); the database scopes the key per lender.
- **The provider callback** `POST /v1/hooks/provider/:endpointToken` lives in the separate receiver process and is deliberately absent from the public API and from `openapi.json`.
- Per-route permissions, error codes and deviations are in the notes: `docs/specs/08a-notes/api-*.md`.

## Borrower: loans, documents, quotations, closure and reminders

| Method | Path                                                  | What it does                                                                           | Operation                     |
| ------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------- |
| GET    | `/v1/loans`                                           | The borrower's loans, with only what the lender reported                               | `listMyLoans`                 |
| GET    | `/v1/loans/{id}`                                      | One loan as the lender reported it                                                     | `getMyLoan`                   |
| GET    | `/v1/loans/{id}/activity`                             | Lender receipts, payment attempts and adjustments of one loan, newest first            | `getMyLoanActivity`           |
| GET    | `/v1/loans/{id}/closure`                              | Closure facts as the lender reported them, with prompt keys and due dates              | `getMyLoanClosure`            |
| GET    | `/v1/loans/{id}/document-requests`                    | The statement and quotation requests made for this loan, newest first                  | `listMyDocumentRequests`      |
| POST   | `/v1/loans/{id}/document-requests/{requestId}/cancel` | Withdraw a request that is still open                                                  | `cancelMyDocumentRequest`     |
| GET    | `/v1/loans/{id}/documents`                            | Statements, quotation letters and no-dues letters the lender issued for this loan      | `listMyLoanDocuments`         |
| GET    | `/v1/loans/{id}/documents/{docId}/content`            | Retrieve a lender-issued document (the exact stored file; every retrieval is recorded) | `downloadMyLoanDocument`      |
| POST   | `/v1/loans/{id}/foreclosure-quotes`                   | Ask the lender for a foreclosure quotation                                             | `requestMyForeclosureQuote`   |
| GET    | `/v1/loans/{id}/foreclosure-quotes/latest`            | The newest unexpired foreclosure quotation, as the lender reported it                  | `getMyLatestForeclosureQuote` |
| GET    | `/v1/loans/{id}/schedule`                             | The repayment schedule exactly as the lender reported it                               | `getMyLoanSchedule`           |
| POST   | `/v1/loans/{id}/statements`                           | Ask the lender for a statement of account                                              | `requestMyLoanStatement`      |
| GET    | `/v1/me/reminders`                                    | The service messages the lender sent about due dates, newest first                     | `listMyReminders`             |
| POST   | `/v1/me/reminders/{id}/read`                          | Record that the borrower opened one of their own reminders                             | `markMyReminderRead`          |

## Borrower: payments

| Method | Path                             | What it does                                                                        | Operation           |
| ------ | -------------------------------- | ----------------------------------------------------------------------------------- | ------------------- |
| GET    | `/v1/loans/{id}/payment-options` | What can be paid on this loan now                                                   | `getPaymentOptions` |
| POST   | `/v1/loans/{id}/payments`        | Ask to pay this loan (the lender decides the amounts; the provider takes the money) | `requestPayment`    |
| GET    | `/v1/payments/{id}`              | One of your payments, with its honest stage                                         | `getPayment`        |
| POST   | `/v1/payments/{id}/cancel`       | Cancel a payment that has no order at the provider yet                              | `cancelPayment`     |
| GET    | `/v1/payments/{id}/link`         | The provider's checkout link for a pending payment                                  | `getPaymentLink`    |

## Borrower: mandates

| Method | Path                             | What it does                                                                                   | Operation           |
| ------ | -------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------- |
| GET    | `/v1/loans/{id}/mandate-options` | Which mandate rails the lender offers for this loan                                            | `getMandateOptions` |
| POST   | `/v1/loans/{id}/mandates`        | Ask for a mandate for automatic debits (needs a verified step-up code bound to the mandate id) | `requestMandate`    |
| GET    | `/v1/mandates`                   | Your mandates, newest first                                                                    | `listMandates`      |
| GET    | `/v1/mandates/{id}`              | One of your mandates                                                                           | `getMandate`        |
| POST   | `/v1/mandates/{id}/cancel`       | Ask to cancel a mandate                                                                        | `cancelMandate`     |
| GET    | `/v1/mandates/{id}/debits`       | The newest debits of one of your mandates, with the pre-debit notice state                     | `listMandateDebits` |
| GET    | `/v1/mandates/{id}/link`         | The provider's authorisation link for a mandate waiting for you                                | `getMandateLink`    |

## Lender: loans, imports, sync, conflicts

| Method | Path                                         | What it does                                                                                                                       | Operation                       |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| GET    | `/v1/lender/imports`                         | Import batches (one per distinct file), newest first                                                                               | `listLenderImports`             |
| POST   | `/v1/lender/imports`                         | Stage a file of loan, receipt or schedule reports of the lender: validate it as a whole and store the preview (nothing is applied) | `stageLenderImport`             |
| GET    | `/v1/lender/imports/{id}`                    | One import batch with its row-level problems                                                                                       | `getLenderImport`               |
| POST   | `/v1/lender/imports/{id}/commit`             | Apply a previewed batch: every record in one transaction, or none                                                                  | `commitLenderImport`            |
| POST   | `/v1/lender/imports/{id}/reject`             | Discard a previewed batch with a reason; its content is dropped                                                                    | `rejectLenderImport`            |
| POST   | `/v1/lender/lms-connection`                  | Create or change the lender's single LMS connection                                                                                | `setLenderLmsConnection`        |
| GET    | `/v1/lender/loans`                           | Loan accounts as your system reported them, newest first                                                                           | `listLenderLoans`               |
| GET    | `/v1/lender/loans/{id}`                      | One loan with the newest report, its staleness, the newest schedule, recent receipts and the flags that wait                       | `getLenderLoan`                 |
| GET    | `/v1/lender/sync/anomalies`                  | Flags the sync raised next to what the lender reported, newest first                                                               | `listLenderSyncAnomalies`       |
| GET    | `/v1/lender/sync/conflicts`                  | Records reported twice with different content, newest first                                                                        | `listLenderSyncConflicts`       |
| POST   | `/v1/lender/sync/conflicts/{id}/acknowledge` | Acknowledge a conflict (you have seen it and will look at it)                                                                      | `acknowledgeLenderSyncConflict` |
| POST   | `/v1/lender/sync/conflicts/{id}/resolve`     | Resolve an acknowledged conflict: which version the lender confirms, why, and what was reviewed                                    | `resolveLenderSyncConflict`     |
| GET    | `/v1/lender/sync/status`                     | Where the sync stands for each of your lenders: the connection and counts over the loans                                           | `getLenderSyncStatus`           |

## Lender: documents, quotations, closure and security release

| Method | Path                                                | What it does                                                                                                                | Operation                             |
| ------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| GET    | `/v1/lender/closures`                               | Loans your system reported closed or foreclosed, with the no-dues status and the security-release tasks                     | `listLenderClosures`                  |
| GET    | `/v1/lender/document-requests`                      | Borrowers' requests for a statement, quotation, no-dues certificate or closure letter, newest first                         | `listLenderDocumentRequests`          |
| POST   | `/v1/lender/document-requests/{id}/decline`         | Decline a borrower's request with a reason the borrower can read                                                            | `declineLenderDocumentRequest`        |
| GET    | `/v1/lender/loans/{id}/documents`                   | Documents your organisation issued for a loan, newest first                                                                 | `listLenderLoanDocuments`             |
| POST   | `/v1/lender/loans/{id}/documents`                   | Register a statement, quotation letter, no-dues certificate or closure letter your organisation issued (PDF, at most 8 MiB) | `uploadLenderLoanDocument`            |
| GET    | `/v1/lender/loans/{id}/documents/{docId}/content`   | Retrieve the exact file of a document of a loan of yours (every retrieval is recorded)                                      | `downloadLenderLoanDocument`          |
| GET    | `/v1/lender/loans/{id}/foreclosure-quotes`          | Quotations recorded for a loan, newest first                                                                                | `listLenderForeclosureQuotes`         |
| POST   | `/v1/lender/loans/{id}/foreclosure-quotes`          | Record a foreclosure quotation exactly as your organisation issued it                                                       | `recordLenderForeclosureQuote`        |
| POST   | `/v1/lender/loans/{id}/security-release-tasks`      | Record the collateral your organisation holds on a closed loan, so each release can be tracked                              | `openLenderSecurityReleaseTasks`      |
| POST   | `/v1/lender/security-release/{taskId}/confirm`      | Confirm that your organisation released the security, with your own confirmation reference                                  | `confirmLenderSecurityRelease`        |
| POST   | `/v1/lender/security-release/{taskId}/delay-reason` | Record why a release is late (your own words, shown to the borrower)                                                        | `setLenderSecurityReleaseDelayReason` |

## Lender: payments and provider events

| Method | Path                                             | What it does                                                                                                                  | Operation                            |
| ------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| GET    | `/v1/lender/merchants`                           | The lender's merchant identifiers and their verification state                                                                | `listLenderMerchants`                |
| POST   | `/v1/lender/merchants`                           | Claim the lender's merchant identifier at a provider (payment.configure, aal2)                                                | `claimMerchant`                      |
| POST   | `/v1/lender/merchants/{id}/withdraw`             | Withdraw one of the lender's unverified merchant claims (payment.configure, aal2)                                             | `withdrawMerchantClaim`              |
| GET    | `/v1/lender/payment-configs`                     | The lender's payment configurations, newest first                                                                             | `listLenderPaymentConfigs`           |
| POST   | `/v1/lender/payment-configs`                     | Draft a payment configuration (payment.configure, aal2)                                                                       | `draftPaymentConfig`                 |
| GET    | `/v1/lender/payment-configs/{id}`                | One payment configuration of the lender                                                                                       | `getLenderPaymentConfig`             |
| POST   | `/v1/lender/payment-configs/{id}/decide`         | Approve or reject a submitted configuration (payment.config.approve, aal2, a different person than the drafter and submitter) | `decidePaymentConfig`                |
| GET    | `/v1/lender/payment-configs/{id}/history`        | The append-only history of one payment configuration (status changes and their reason codes)                                  | `getLenderPaymentConfigHistory`      |
| POST   | `/v1/lender/payment-configs/{id}/retire`         | Retire an active or suspended configuration (the lender approver, aal2)                                                       | `retirePaymentConfig`                |
| POST   | `/v1/lender/payment-configs/{id}/submit`         | Submit a draft (or a suspended) configuration for approval (payment.configure, aal2)                                          | `submitPaymentConfig`                |
| POST   | `/v1/lender/payment-configs/{id}/suspend`        | Platform kill switch: suspend an active configuration (platform.payments.providers.manage, aal2, one person)                  | `suspendPaymentConfigOnLenderPath`   |
| POST   | `/v1/lender/payment-configs/{id}/withdraw`       | Withdraw a draft or pending configuration (payment.configure, aal2)                                                           | `withdrawPaymentConfig`              |
| GET    | `/v1/lender/payment-policy`                      | What your lenders accept as a payment: partial amounts, part-prepayments and link validity                                    | `listLenderPaymentPolicies`          |
| POST   | `/v1/lender/payment-policy`                      | Set what you accept as a payment (partial amounts, part-prepayments, link validity)                                           | `setLenderPaymentPolicy`             |
| GET    | `/v1/lender/payment-providers`                   | The approved providers a lender can draft a payment configuration for                                                         | `listPaymentProviderChoices`         |
| GET    | `/v1/lender/payments`                            | Payment requests of your borrowers, newest first                                                                              | `listLenderPayments`                 |
| GET    | `/v1/lender/payments/{id}`                       | One payment request with the provider payments, the refunds and chargebacks, and the derived settlement stage                 | `getLenderPayment`                   |
| GET    | `/v1/lender/provider-events`                     | Verified provider events and what happened when they were applied, newest first                                               | `listLenderProviderEvents`           |
| GET    | `/v1/lender/settlement-accounts`                 | The lender's own settlement accounts (masked) and whether each is linked to the registry                                      | `listLenderSettlementAccounts`       |
| POST   | `/v1/lender/settlement-accounts`                 | Ask for one of the lender's own settlement accounts to be set up (payment.configure, aal2)                                    | `requestSettlementAccount`           |
| GET    | `/v1/lender/settlement-accounts/registry-status` | Registry state of the lender's own settlement accounts: masked reference, status, dates and whether usable now                | `getSettlementAccountRegistryStatus` |
| POST   | `/v1/lender/settlement-accounts/{id}/withdraw`   | Withdraw a settlement account request that was never linked to the registry (payment.configure, aal2)                         | `withdrawSettlementAccount`          |
| GET    | `/v1/lender/webhook-summary`                     | How many provider callbacks reached your payment configurations, by outcome                                                   | `getLenderWebhookSummary`            |

## Lender: mandates

| Method | Path                        | What it does                                                                                | Operation                   |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------- | --------------------------- |
| GET    | `/v1/lender/mandate-debits` | Debits of your mandates (planned and reported), newest scheduled date first                 | `listLenderMandateDebits`   |
| GET    | `/v1/lender/mandate-policy` | Your mandate settings: requirement, ceiling on one debit and the pre-debit notice lead time | `listLenderMandatePolicies` |
| POST   | `/v1/lender/mandate-policy` | Set your mandate settings                                                                   | `setLenderMandatePolicy`    |
| GET    | `/v1/lender/mandates`       | Mandates of your borrowers with the status the provider last confirmed, newest first        | `listLenderMandates`        |
| GET    | `/v1/lender/mandates/{id}`  | One mandate with its status history, its newest debits and the pre-debit notices            | `getLenderMandate`          |

## Lender: reconciliation and exceptions

| Method | Path                                                      | What it does                                                                                     | Operation                            |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------ |
| POST   | `/v1/lender/reconciliation/bank-credits`                  | Report credits that reached one of your settlement accounts (value date, amount, bank reference) | `importLenderBankCredits`            |
| GET    | `/v1/lender/reconciliation/exceptions`                    | Exceptions raised for your lenders, newest first                                                 | `listLenderReconciliationExceptions` |
| GET    | `/v1/lender/reconciliation/exceptions/{id}`               | One exception with its history                                                                   | `getLenderReconciliationException`   |
| POST   | `/v1/lender/reconciliation/exceptions/{id}/acknowledge`   | Acknowledge an exception (you have seen it and will look at it)                                  | `acknowledgeReconciliationException` |
| POST   | `/v1/lender/reconciliation/exceptions/{id}/assign`        | Assign an exception to someone who may act on it                                                 | `assignReconciliationException`      |
| POST   | `/v1/lender/reconciliation/exceptions/{id}/reopen`        | Reopen a resolved exception with a reason from the closed list                                   | `reopenReconciliationException`      |
| POST   | `/v1/lender/reconciliation/exceptions/{id}/resolve`       | Resolve an exception with a reason from the closed list and the evidence you reviewed            | `resolveReconciliationException`     |
| GET    | `/v1/lender/reconciliation/runs`                          | Reconciliation runs of your lenders, newest first                                                | `listLenderReconciliationRuns`       |
| GET    | `/v1/lender/reconciliation/settings`                      | How long reconciliation waits before it calls a missing item an exception                        | `listLenderReconciliationSettings`   |
| POST   | `/v1/lender/reconciliation/settings`                      | Set the waiting times of reconciliation                                                          | `setLenderReconciliationSettings`    |
| GET    | `/v1/lender/reconciliation/settlement-batches`            | Settlement batches as the provider reported them, newest first                                   | `listLenderSettlementBatches`        |
| GET    | `/v1/lender/reconciliation/settlement-batches/{id}`       | One settlement batch                                                                             | `getLenderSettlementBatch`           |
| GET    | `/v1/lender/reconciliation/settlement-batches/{id}/items` | The payments listed in one settlement batch, in the order they were stored                       | `listLenderSettlementItems`          |
| GET    | `/v1/lender/reconciliation/summary`                       | The newest reconciliation run of a lender for a date, with its counts and report                 | `getLenderReconciliationSummary`     |

## Lender: reminders

| Method | Path                                          | What it does                                                                                        | Operation                        |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------- |
| GET    | `/v1/lender/communication-holds`              | Pauses on reminders for your loans, newest first                                                    | `listLenderCommunicationHolds`   |
| POST   | `/v1/lender/communication-holds/{id}/release` | Release a hold                                                                                      | `releaseLenderCommunicationHold` |
| POST   | `/v1/lender/loans/{id}/communication-hold`    | Pause reminders for one loan                                                                        | `placeLenderCommunicationHold`   |
| GET    | `/v1/lender/penal-charge-texts`               | Your penal-charge disclosure versions as you submitted them, newest first                           | `listLenderPenalChargeTexts`     |
| POST   | `/v1/lender/penal-charge-texts`               | Draft your penal-charge disclosure: the figure, your two attestations, the reason and the sentences | `draftLenderPenalChargeText`     |
| POST   | `/v1/lender/penal-charge-texts/{id}/approve`  | Approve a drafted penal-charge text (a different person than the drafter)                           | `approveLenderPenalChargeText`   |
| POST   | `/v1/lender/penal-charge-texts/{id}/retire`   | Retire a draft or approved penal-charge text                                                        | `retireLenderPenalChargeText`    |
| GET    | `/v1/lender/reminder-policies`                | Your reminder policy versions (draft, approved, retired), newest first                              | `listLenderReminderPolicies`     |
| POST   | `/v1/lender/reminder-policies`                | Draft the next version of your reminder policy                                                      | `draftLenderReminderPolicy`      |
| POST   | `/v1/lender/reminder-policies/{id}/approve`   | Approve a drafted reminder policy (a different person than the drafter)                             | `approveLenderReminderPolicy`    |
| POST   | `/v1/lender/reminder-policies/{id}/retire`    | Retire a draft or approved reminder policy                                                          | `retireLenderReminderPolicy`     |
| GET    | `/v1/lender/reminder-templates`               | Your reminder wording versions per kind and language, newest first                                  | `listLenderReminderTemplates`    |
| POST   | `/v1/lender/reminder-templates`               | Draft the next version of your wording for a kind and language                                      | `draftLenderReminderTemplate`    |
| POST   | `/v1/lender/reminder-templates/{id}/approve`  | Approve a drafted reminder wording (a different person than the drafter)                            | `approveLenderReminderTemplate`  |
| POST   | `/v1/lender/reminder-templates/{id}/retire`   | Retire a draft or approved reminder wording                                                         | `retireLenderReminderTemplate`   |
| GET    | `/v1/lender/reminders`                        | Planned, sent and suppressed reminders for your loans, newest scheduled first                       | `listLenderReminders`            |
| GET    | `/v1/lender/reminders/summary`                | How many reminders of your lender are in each status, suppression reason and channel                | `getLenderReminderSummary`       |
| GET    | `/v1/lender/reminders/{id}/deliveries`        | The attempt log of one reminder, oldest first                                                       | `listLenderReminderDeliveries`   |

## Lender: feature switches

| Method | Path                  | What it does                                                                                       | Operation                |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------- | ------------------------ |
| GET    | `/v1/lender/features` | The lender's own switch state (read-only; the platform changes switches through a two-person flow) | `listOwnFeatureSwitches` |

## Platform: accounts, providers, merchants, payment configurations

| Method | Path                                                      | What it does                                                                                                                                                        | Operation                          |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| GET    | `/v1/platform/account-format-rules`                       | Account-number format rules by country and account type, with their evidence label and approval state                                                               | `listAccountFormatRules`           |
| POST   | `/v1/platform/account-format-rules`                       | Draft a new version of an account-number format rule (platform.accounts.registry.manage, aal2)                                                                      | `draftAccountFormatRule`           |
| POST   | `/v1/platform/account-format-rules/{id}/approve`          | Approve a proposed rule (platform.accounts.registry.verify, aal2, a different person than the proposer)                                                             | `approveAccountFormatRule`         |
| POST   | `/v1/platform/account-format-rules/{id}/retire`           | Retire a rule (either registry permission, one person, a reason of 10 or more characters)                                                                           | `retireAccountFormatRule`          |
| POST   | `/v1/platform/account-format-rules/{id}/submit`           | Take responsibility for proposing a draft rule that has no proposer (the seeded one)                                                                                | `submitAccountFormatRule`          |
| GET    | `/v1/platform/accounts`                                   | Registered accounts, masked: owner, purposes, dates and verification state (never the fingerprint)                                                                  | `listRegistryAccounts`             |
| POST   | `/v1/platform/accounts`                                   | Register an account under an owner and permitted purposes (platform.accounts.registry.manage, aal2)                                                                 | `registerAccount`                  |
| GET    | `/v1/platform/accounts/{id}`                              | One registered account, masked                                                                                                                                      | `getRegistryAccount`               |
| POST   | `/v1/platform/accounts/{id}/reject`                       | Reject an unverified registration (either registry permission, one person, a reason)                                                                                | `rejectRegistryAccount`            |
| POST   | `/v1/platform/accounts/{id}/revoke`                       | Revoke a registration for good (either registry permission, one person, a reason)                                                                                   | `revokeRegistryAccount`            |
| POST   | `/v1/platform/accounts/{id}/verify`                       | Verify a registered account (platform.accounts.registry.verify, aal2, a different person than the registrant)                                                       | `verifyRegistryAccount`            |
| GET    | `/v1/platform/fingerprint-key-versions`                   | The versions of the account fingerprint key (proposed, active, retired); never the key                                                                              | `listFingerprintKeyVersions`       |
| POST   | `/v1/platform/fingerprint-key-versions`                   | Propose the next fingerprint key version (platform.accounts.registry.manage, aal2)                                                                                  | `proposeFingerprintKeyVersion`     |
| POST   | `/v1/platform/fingerprint-key-versions/{version}/approve` | Approve a proposed key version (platform.accounts.registry.verify, aal2, a different login than the proposer)                                                       | `approveFingerprintKeyVersion`     |
| GET    | `/v1/platform/merchants`                                  | Every merchant claim, so the platform can verify or revoke it                                                                                                       | `listPlatformMerchants`            |
| POST   | `/v1/platform/merchants/{id}/revoke`                      | Revoke a merchant (platform.payments.providers.manage, aal2)                                                                                                        | `revokeMerchant`                   |
| POST   | `/v1/platform/merchants/{id}/verify`                      | Confirm, against evidence, that a lender's claimed merchant identifier is its own (platform.payments.providers.manage, aal2)                                        | `verifyMerchant`                   |
| GET    | `/v1/platform/payment-configs`                            | Payment configurations of every lender (platform)                                                                                                                   | `listPlatformPaymentConfigs`       |
| GET    | `/v1/platform/payment-configs/{id}`                       | One payment configuration (platform)                                                                                                                                | `getPlatformPaymentConfig`         |
| POST   | `/v1/platform/payment-configs/{id}/release-hold`          | Lift the hold of a suspended configuration (platform.payments.providers.manage, aal2, a reason; a platform hold only by a different person)                         | `releasePaymentConfigHold`         |
| POST   | `/v1/platform/payment-configs/{id}/retire`                | Retire an active or suspended configuration (platform.payments.providers.manage, aal2)                                                                              | `retirePaymentConfigAsPlatform`    |
| POST   | `/v1/platform/payment-configs/{id}/suspend`               | Platform kill switch: suspend an active configuration (platform.payments.providers.manage, aal2, one person)                                                        | `suspendPaymentConfig`             |
| GET    | `/v1/platform/payment-providers`                          | The provider register: who may be used for payments or mandates, and the evidence behind it (read from the platform view; lenders read only the vocabulary columns) | `listPaymentProviders`             |
| POST   | `/v1/platform/payment-providers`                          | Register or update a payment or mandate provider (platform.payments.providers.manage, aal2)                                                                         | `setPaymentProvider`               |
| GET    | `/v1/platform/return-code-classes`                        | How each provider return code is classified, with the evidence it comes from                                                                                        | `listReturnCodeClasses`            |
| POST   | `/v1/platform/return-code-classes`                        | Classify one provider return code, with its evidence (platform.payments.providers.manage, aal2)                                                                     | `setReturnCodeClass`               |
| GET    | `/v1/platform/settlement-accounts`                        | Lenders settlement accounts (masked) that a registry manager can link to a verified registry entry                                                                  | `listSettlementAccountsForLinking` |
| POST   | `/v1/platform/settlement-accounts/{id}/link`              | Link a lender's settlement account to its verified registry entry (platform.accounts.registry.manage, aal2)                                                         | `linkSettlementAccount`            |
| POST   | `/v1/platform/udofin-fee-merchants`                       | Register Udofin's own fee merchant (platform.payments.providers.manage, aal2)                                                                                       | `registerUdofinFeeMerchant`        |

## Platform: feature switches

| Method | Path                                               | What it does                                                                                                      | Operation                   |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------- |
| GET    | `/v1/platform/feature-change-requests`             | Requests to turn a switch on or off, newest first                                                                 | `listFeatureChangeRequests` |
| POST   | `/v1/platform/feature-change-requests`             | Ask for a per-lender switch to change (platform.features.manage, aal2)                                            | `requestFeatureChange`      |
| POST   | `/v1/platform/feature-change-requests/{id}/cancel` | Cancel your own pending switch change request (platform.features.manage, aal2)                                    | `cancelFeatureChange`       |
| POST   | `/v1/platform/feature-change-requests/{id}/decide` | Approve or reject a pending switch change (platform.features.manage, aal2, a different person than the requester) | `decideFeatureChange`       |
| GET    | `/v1/platform/features`                            | The feature catalogue: which switches exist, which can be enabled, and why the others cannot                      | `listFeatureCatalogue`      |
| POST   | `/v1/platform/features/kill`                       | Emergency kill switch: turn a feature off at once, for one lender (platform.features.manage, aal2, one person)    | `killFeature`               |
| GET    | `/v1/platform/lenders/{lenderId}/features`         | The switch state of one lender, for every feature in the catalogue (off unless a two-person change turned it on)  | `listLenderFeatureSwitches` |

## Platform: exceptions

| Method | Path                      | What it does                                                        | Operation                       |
| ------ | ------------------------- | ------------------------------------------------------------------- | ------------------------------- |
| GET    | `/v1/platform/exceptions` | Open platform-owned payment exceptions across lenders, newest first | `listPlatformPaymentExceptions` |
